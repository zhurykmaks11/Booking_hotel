# Progressive delivery: Canary з Argo Rollouts (DevOps, Лаб. №6)

Звичайний `Deployment` API замінено на `Rollout` (Argo Rollouts). Нова версія виходить не на всі поди одразу, а кроками: 25 % подів → **ручна пауза** → 50 % → 30 с → 75 % → 30 с → 100 %. На ручній паузі нову версію перевіряють на частині реального трафіку, а потім або продовжують реліз (`promote`), або скасовують його (`abort`). Як і в Лаб. №5, усе розгортається з Git через Argo CD: контролер Argo Rollouts — окремим Application-ом, реліз — комітом зі зміною тега образу.

**Вихідні дані** (Лаб. №5): minikube, Argo CD v3.5, App of Apps (`bootstrap/root.yaml` → `argocd-apps/`), застосунок `booking-hotel` у namespace `booking-hotel-gitops`, `values-minikube.yaml` — джерело правди, `selfHeal` і `prune` увімкнено, кожна зміна в `main` — через PR.

## Зміст

1. [Відповідність завданню](#1-відповідність-завданню)
2. [Контролер Argo Rollouts через Argo CD](#2-контролер-argo-rollouts-через-argo-cd)
3. [Rollout у Helm-чарті](#3-rollout-у-helm-чарті)
4. [Стратегія: canary](#4-стратегія-canary)
5. [Реліз через Git і promote](#5-реліз-через-git-і-promote)
6. [Скасування релізу: abort і відкат через Git](#6-скасування-релізу-abort-і-відкат-через-git)
7. [Пояснення кожного файлу](#7-пояснення-кожного-файлу)
8. [Захист: лайв-демонстрація](#8-захист-лайв-демонстрація)
9. [Типові помилки](#9-типові-помилки)
10. [Питання до захисту](#10-питання-до-захисту)

---

## 1. Відповідність завданню

| Пункт | Вимога | Як зроблено | Файли |
|---|---|---|---|
| 1a | Application для Helm-чарту `argo-rollouts` в `argocd-apps/` | Application з офіційного репозиторію `argo-helm`, чарт `2.43.8` (Rollouts v1.10.1), namespace `argo-rollouts`, `selfHeal` + `prune`, sync-wave `-1` | `argocd-apps/argo-rollouts.yaml` |
| 1b | Плагін `kubectl argo rollouts` | `kubectl-argo-rollouts.exe` v1.10.1 у `%USERPROFILE%\bin` | — (розд. 2.2) |
| 2 | Шаблон `Rollout`, вмикається параметром і замінює Deployment; ≥ 4 реплік | `api.rollout.enabled`: `true` → `api-rollout.yaml`, `false` → `api-deployment.yaml`. Шаблон пода спільний (`_api-pod.tpl`). `replicaCount: 4`; рендер падає, якщо реплік < 4 | `templates/api-rollout.yaml`, `templates/_api-pod.tpl`, `templates/api-deployment.yaml`, `values-minikube.yaml` |
| 3a | Canary: ≥ 3 кроки `setWeight`, одна ручна пауза `pause: {}` і хоча б одна з таймером | `setWeight` 25 / 50 / 75, `pause: {}` після 25 %, `pause: {duration: 30s}` після 50 % і 75 % | `values.yaml` (`api.rollout.strategy`) |
| 3 | Усно: чому саме ця стратегія | розд. 4.2 | — |
| 4a | Реліз зміною тега в Git; проміжне співвідношення подів, відповіді обох версій з циклу запитів у кластері; `promote` на ручній паузі | розд. 5 | `values-minikube.yaml` |
| 5 | Ще один реліз → `abort` → повернення на stable; `Synced` / `Degraded` у Argo CD і пояснення; відкат через Git | розд. 6 | `values-minikube.yaml` |
| 6 | Лайв-демонстрація пп. 4–5 | сценарій у розд. 8 | — |

## 2. Контролер Argo Rollouts через Argo CD

### 2.1. Application `argo-rollouts`

`Rollout` — не вбудований об'єкт Kubernetes, а CRD. Його кроки виконує окремий контролер Argo Rollouts: він створює ReplicaSet-и stable і canary і масштабує їх згідно з `steps`. Контролер встановлюється так само, як застосунок, — файлом у `argocd-apps/`. Root (App of Apps) підхоплює файл після мерджу в `main`, жодних `helm install` / `kubectl apply` вручну.

```yaml
# argocd-apps/argo-rollouts.yaml (скорочено)
metadata:
  name: argo-rollouts
  annotations:
    argocd.argoproj.io/sync-wave: "-1"     # раніше за booking-hotel (wave 0)
spec:
  source:
    repoURL: https://argoproj.github.io/argo-helm   # Helm-репозиторій, а не Git
    chart: argo-rollouts
    targetRevision: 2.43.8                          # Argo Rollouts v1.10.1, версія зафіксована
    helm:
      releaseName: argo-rollouts
      valuesObject:
        controller: { replicas: 1 }                 # для minikube досить одного (за замовчуванням 2)
        dashboard: { enabled: true }                # веб-дашборд у кластері
  destination:
    namespace: argo-rollouts
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

- **Джерело — Helm-репозиторій.** Для чарту з репозиторію замість `path` вказується `chart`, а `targetRevision` — це версія чарту. Конкретна версія, а не `*`, щоб оновлення контролера теж було комітом.
- **`valuesObject`** — значення чарту прямо в Application, без окремого файлу.
- **`ServerSideApply=true`.** CRD `Rollout` містить повну OpenAPI-схему шаблону пода. Під час звичайного (client-side) apply вона потрапляє в анотацію `last-applied-configuration`, яка перевищує ліміт 256 KB, і синхронізація падає з `metadata.annotations: Too long`. Server-side apply анотацію не пише.
- **sync-wave `-1`.** Root синхронізує дочірні Application-и хвилями: спершу `argo-rollouts` (CRD), потім `booking-hotel` (сам Rollout). Якщо CRD ще не встановлено, `booking-hotel` повторить синхронізацію (`retry`, розд. 3.4).

### 2.2. Плагін `kubectl argo rollouts`

Плагін kubectl — виконуваний файл `kubectl-<назва>` у PATH; kubectl сам знаходить його за назвою.

```powershell
Invoke-WebRequest https://github.com/argoproj/argo-rollouts/releases/download/v1.10.1/kubectl-argo-rollouts-windows-amd64 `
  -OutFile "$env:USERPROFILE\bin\kubectl-argo-rollouts.exe"
kubectl argo rollouts version          # kubectl-argo-rollouts: v1.10.1
```

`%USERPROFILE%\bin` уже в PATH з Лаб. №5 (там лежить `argocd.exe`).

Основні команди:

| Команда | Що робить |
|---|---|
| `kubectl argo rollouts get rollout <name> -n <ns> --watch` | дерево Rollout → ReplicaSet-и → поди, поточний крок, вага, статус; оновлюється наживо |
| `kubectl argo rollouts promote <name>` | зняти поточну паузу й перейти до наступного кроку |
| `kubectl argo rollouts promote <name> --full` | пропустити всі кроки, одразу 100 % |
| `kubectl argo rollouts abort <name>` | скасувати реліз: canary → 0, stable → усі репліки |
| `kubectl argo rollouts retry rollout <name>` | почати скасований реліз заново з першого кроку |
| `kubectl argo rollouts dashboard` | локальний веб-дашборд, `http://localhost:3100` |

### 2.3. Перевірка встановлення

```powershell
argocd app list                                   # root, argo-rollouts, booking-hotel: Synced, Healthy
kubectl -n argo-rollouts get pods                 # argo-rollouts-..., argo-rollouts-dashboard-...: Running
kubectl get crd | Select-String argoproj.io       # rollouts, analysistemplates, experiments, ... + applications Argo CD
```

## 3. Rollout у Helm-чарті

### 3.1. Один шаблон пода — два об'єкти

Шаблон пода API (контейнер, проби, ресурси, `envFrom`, анотації `checksum/*`) винесено з `api-deployment.yaml` в іменований шаблон `booking-hotel.apiPodTemplate` у файлі `_api-pod.tpl`. Файли з `_` на початку Helm не рендерить як маніфести, вони містять лише `define`. Deployment і Rollout підставляють той самий шаблон:

```yaml
  template:
    {{- include "booking-hotel.apiPodTemplate" . | nindent 4 }}
```

Під одним прапорцем рендериться рівно один із двох об'єктів:

```yaml
# api-deployment.yaml               # api-rollout.yaml
{{- if not .Values.api.rollout.enabled }}   {{- if .Values.api.rollout.enabled }}
kind: Deployment                            kind: Rollout
...                                         ...
{{- end }}                                  {{- end }}
```

Рефакторинг перевірено: з `api.rollout.enabled: false` рендер Deployment-а збігається з попередньою версією чарту байт у байт (`helm template` до і після + `diff`), лише додано один рядок коментаря. Тож `values-dev.yaml` / `values-prod.yaml` (реліз Лаб. №4) нічого не помітять.

### 3.2. `api-rollout.yaml`

```yaml
{{- if .Values.api.rollout.enabled }}
{{- if lt (int .Values.api.replicaCount) 4 }}
{{- fail "api.rollout.enabled: потрібно api.replicaCount >= 4, ..." }}
{{- end }}
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: booking-hotel-api                 # те саме ім'я, що в Deployment
spec:
  replicas: {{ .Values.api.replicaCount }}
  revisionHistoryLimit: 10
  selector:
    matchLabels: ...                      # ті самі selectorLabels, що в Deployment і Service
  strategy:
    {{- toYaml .Values.api.rollout.strategy | nindent 4 }}
  template:
    {{- include "booking-hotel.apiPodTemplate" . | nindent 4 }}
{{- end }}
```

- `spec` Rollout-а повторює `spec` Deployment-а: `replicas`, `selector`, `template`. Відрізняється лише `strategy`: замість `RollingUpdate` — `canary` з кроками.
- Стратегія підставляється з values **як є** (`toYaml`), тож кроки змінюються без правки шаблону.
- **Перевірка реплік.** `fail` зупиняє рендер, якщо реплік менше 4: при 2 репліках вага 25 % і 75 % не виражається цілим числом подів.

### 3.3. Values

`values.yaml` — опис стратегії (за замовчуванням вимкнено, щоб dev/prod з Лаб. №4 лишились на Deployment):

```yaml
api:
  rollout:
    enabled: false
    strategy:
      canary:
        maxSurge: 1
        maxUnavailable: 0
        steps:
          - setWeight: 25        # 1 под canary : 3 stable
          - pause: {}            # ручна пауза: перевірка нової версії, далі promote або abort
          - setWeight: 50        # 2 : 2
          - pause: { duration: 30s }
          - setWeight: 75        # 3 : 1
          - pause: { duration: 30s }
```

`values-minikube.yaml` — середовище під Argo CD:

```yaml
api:
  replicaCount: 4          # було 2 (Лаб. №5)
  image:
    tag: "1.1.0"           # реліз = зміна цього рядка
  rollout:
    enabled: true
```

Версія чарту `0.2.0` → `0.3.0`: новий параметр і новий шаблон. `appVersion` без змін.

### 3.4. Перехід з Deployment на Rollout без простою

Після мерджу в кластері одночасно відбувається: створюється Rollout, а Deployment зникає з Git, тож `prune` його видаляє. Якщо видалити Deployment раніше, ніж поди Rollout стануть Ready, API кілька десятків секунд буде недоступний (старт пода включає `prisma migrate deploy`). Тому в `argocd-apps/booking-hotel.yaml` додано:

```yaml
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true          # видалення (prune) — останнім кроком, коли нові ресурси вже Healthy
    retry:                      # якщо CRD Rollout ще немає — повторити (10 с, 20 с, 40 с, ... до 2 хв)
      limit: 5
      backoff: { duration: 10s, factor: 2, maxDuration: 2m }
```

На час переходу Service `booking-hotel-api` вибирає і поди Deployment, і поди Rollout: мітки-селектори в них однакові. Перше створення Rollout-а **не проходить кроки canary**: stable-версії ще немає, тому всі 4 поди одразу отримують поточний тег.

## 4. Стратегія: canary

### 4.1. Як рахується вага без traffic router

Argo Rollouts вміє керувати вагою трафіку через Ingress / service mesh (`trafficRouting`). У проєкті їх немає, тому використано **canary на рівні реплік**. Service `booking-hotel-api` вибирає всі поди API за мітками, kube-proxy розподіляє з'єднання між подами приблизно порівну. Отже, частка запитів на нову версію ≈ частка її подів:

| Крок | Вага | Поди canary : stable | Трафік на нову версію |
|---|---|---|---|
| `setWeight: 25` + `pause: {}` | 25 % | 1 : 3 | ~25 % |
| `setWeight: 50` + `pause: 30s` | 50 % | 2 : 2 | ~50 % |
| `setWeight: 75` + `pause: 30s` | 75 % | 3 : 1 | ~75 % |
| кінець | 100 % | 4 : 0 | 100 %, canary стає stable |

`maxSurge: 1`, `maxUnavailable: 0` — як `rollingUpdate` у Deployment. Спершу піднімається под нової версії, і лише коли він Ready, гаситься под старої. Ready-подів завжди 4, на мить 5.

### 4.2. Чому canary, а не blue-green (для усної відповіді)

1. **Одна спільна БД.** Обидві версії API працюють з одним PostgreSQL і Redis. Blue-green не дає ізоляції даних: «зелена» версія пише в ту саму базу, а міграції Prisma (`migrate deploy` на старті пода) виконуються ще до перемикання. Головну перевагу blue-green — «тестуємо, ніхто не зачеплений» — для stateful-частини ми все одно не отримуємо.
2. **Ризик обмежений частиною трафіку.** Помилка нової версії (наприклад, у бронюванні) зачіпає ~25 % запитів на ручній паузі, а не 100 % після миттєвого перемикання blue-green. Реальні запити користувачів — найкраща перевірка, а `abort` повертає все за секунди.
3. **Ресурси minikube.** Blue-green тримає дві повні копії: 4 + 4 = 8 подів API поряд з Argo CD, Postgres і Redis. Canary з `maxSurge: 1` — максимум 5 подів.
4. **Не потрібен traffic router.** API stateless (стан у БД і Redis), будь-який под обслуговує будь-який запит, тож розподіл трафіку за кількістю подів коректний. Ingress-контролер чи mesh не потрібен.
5. **Коли blue-green був би кращим:** версії несумісні між собою (змінено формат відповіді, клієнт не має бачити обидві версії впереміш) або потрібне миттєве перемикання/відкат усього трафіку. Для нашого API, де нова версія лише додає функціональність, це не так.

**Наслідок для міграцій.** Canary-под на 25 % уже застосовує нові міграції до спільної БД, а stable-поди продовжують працювати з новою схемою. Тому міграції мають бути зворотно сумісними (expand → contract): спершу додати колонку/таблицю, і лише в наступному релізі прибрати стару. `abort` повертає поди, але **не відкочує схему БД**.

## 5. Реліз через Git і promote

### 5.1. Підготовка

Образи публікує CI з git-тегу `vX.Y.Z` (Лаб. №3, №5). Для демонстрації потрібні щонайменше дві версії, відмінні від поточної `1.1.0`:

```powershell
git tag -a v1.2.0 main/main -m "Release 1.2.0"
git tag -a v1.3.0 main/main -m "Release 1.3.0"
git push main v1.2.0 v1.3.0
docker manifest inspect ghcr.io/zhurykmaks11/booking-hotel-api:1.2.0 > $null; $?   # True, коли CI опублікував образ
```

Термінали на час демонстрації:

```powershell
# 1) Argo CD UI (https://localhost:8080)
kubectl -n argocd port-forward svc/argocd-server 8080:443

# 2) стан Rollout наживо
kubectl argo rollouts get rollout booking-hotel-api -n booking-hotel-gitops --watch

# 3) цикл запитів УСЕРЕДИНІ кластера: окремий под звертається до Service booking-hotel-api
kubectl -n booking-hotel-gitops run traffic --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- `
  sh -c 'while true; do curl -s -m 2 http://booking-hotel-api/version; echo; sleep 0.5; done'

# 4) (необов'язково) дашборд Rollouts: http://localhost:3100
kubectl argo rollouts dashboard
```

`/version` повертає версію образу і под, який обробив запит:

```json
{"version":"1.1.0","instanceId":"booking-hotel-api-6d8f7c9b5-x2k4q","environment":"production"}
```

Співвідношення версій на 200 запитах — одноразовий под, що рахує відповіді:

```powershell
kubectl -n booking-hotel-gitops run ratio --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- `
  sh -c 'for i in $(seq 200); do curl -s -m 2 http://booking-hotel-api/version | grep -o "\"version\":\"[^\"]*\""; done | sort | uniq -c'
```

### 5.2. Реліз 1.1.0 → 1.2.0

```powershell
git switch -c release-1.2.0 main/main
# helm/booking-hotel/values-minikube.yaml:  tag: "1.1.0"  ->  tag: "1.2.0"
git commit -am "release(gitops): booking-hotel api 1.2.0 (canary)"
git push -u main release-1.2.0
# PR -> зелений CI -> Merge

argocd app get booking-hotel --refresh      # не чекати опитування Git (до 3 хв)
```

Що відбувається:

1. Argo CD бачить новий коміт → `OutOfSync` → автосинхронізація змінює `spec.template` Rollout-а (новий образ) → `Synced`.
2. Контролер Rollouts створює canary-ReplicaSet `1.2.0` і виконує крок 1 `setWeight: 25`: піднімає 1 под `1.2.0`, після його Ready гасить 1 под `1.1.0`.
3. Крок 2 `pause: {}` — **реліз зупиняється і чекає людини**.

Проміжний стан у CLI (`get rollout --watch`):

```
Name:            booking-hotel-api
Namespace:       booking-hotel-gitops
Status:          ॥ Paused
Message:         CanaryPauseStep
Strategy:        Canary
  Step:          1/6
  SetWeight:     25
  ActualWeight:  25
Images:          ghcr.io/zhurykmaks11/booking-hotel-api:1.1.0 (stable)
                 ghcr.io/zhurykmaks11/booking-hotel-api:1.2.0 (canary)
Replicas:
  Desired:       4
  Current:       4
  Updated:       1
  Ready:         4
  Available:     4

NAME                                          KIND        STATUS     INFO
⟳ booking-hotel-api                           Rollout     ॥ Paused
├──# revision:2
│  └──⧉ booking-hotel-api-<hash-1.2.0>        ReplicaSet  ✔ Healthy  canary
│     └──□ booking-hotel-api-<hash>-aaaaa     Pod         ✔ Running  ready:1/1
└──# revision:1
   └──⧉ booking-hotel-api-<hash-1.1.0>        ReplicaSet  ✔ Healthy  stable
      ├──□ booking-hotel-api-<hash>-bbbbb     Pod         ✔ Running  ready:1/1
      ├──□ booking-hotel-api-<hash>-ccccc     Pod         ✔ Running  ready:1/1
      └──□ booking-hotel-api-<hash>-ddddd     Pod         ✔ Running  ready:1/1
```

У циклі запитів — відповіді обох версій упереміш, приблизно кожна четверта від `1.2.0`:

```
{"version":"1.1.0","instanceId":"booking-hotel-api-<hash-1.1.0>-bbbbb",...}
{"version":"1.1.0","instanceId":"booking-hotel-api-<hash-1.1.0>-ccccc",...}
{"version":"1.2.0","instanceId":"booking-hotel-api-<hash-1.2.0>-aaaaa",...}
{"version":"1.1.0","instanceId":"booking-hotel-api-<hash-1.1.0>-ddddd",...}
```

В Argo CD: `booking-hotel` — **Synced / Suspended**. У дереві під Rollout-ом два ReplicaSet-и: 1 под нової версії, 3 старої. Suspended — це стан здоров'я Rollout-а на паузі, а не помилка.

### 5.3. Promote

```powershell
kubectl argo rollouts promote booking-hotel-api -n booking-hotel-gitops
```

Альтернатива в інтерфейсі Argo CD: Rollout → ⋮ → **Resume**.

Далі без участі людини: `setWeight: 50` (2 : 2) → пауза 30 с → `setWeight: 75` (3 : 1) → пауза 30 с → 100 %. Canary-ReplicaSet стає stable, старий масштабується до 0. У циклі запитів частка `1.2.0` зростає до 100 %. Argo CD: `Suspended` → `Progressing` → **Synced / Healthy**.

`promote` змінює лише **статус** Rollout-а (знімає умову паузи), а не `spec`. Тому Argo CD не бачить розбіжності з Git і `selfHeal` нічого не повертає.

## 6. Скасування релізу: abort і відкат через Git

### 6.1. Реліз 1.2.0 → 1.3.0 і abort на ручній паузі

```powershell
git switch -c release-1.3.0 main/main
# values-minikube.yaml: tag: "1.2.0" -> tag: "1.3.0"
git commit -am "release(gitops): booking-hotel api 1.3.0 (canary)"
git push -u main release-1.3.0
# PR -> Merge
argocd app get booking-hotel --refresh
# Rollout дійшов до pause: {} — 1 под 1.3.0, 3 поди 1.2.0

kubectl argo rollouts abort booking-hotel-api -n booking-hotel-gitops
```

Що робить `abort`:

- canary-ReplicaSet `1.3.0` масштабується до 0, stable `1.2.0` повертається до 4 подів;
- увесь трафік знову на `1.2.0` — видно в циклі запитів і в `ratio`;
- Rollout: `Status: ✖ Degraded`, `Message: RolloutAborted: Rollout aborted update to revision 3`.

```
Status:          ✖ Degraded
Message:         RolloutAborted: Rollout aborted update to revision 3
Images:          ghcr.io/zhurykmaks11/booking-hotel-api:1.2.0 (stable)
Replicas:        Desired 4, Current 4, Updated 0, Ready 4, Available 4
```

### 6.2. Чому Argo CD показує Synced / Degraded

`booking-hotel` в Argo CD: **Synced / Degraded**. Це два незалежні виміри (Лаб. №5):

- **Sync = Synced.** Argo CD порівнює **маніфести**: у Git `tag: "1.3.0"`, у `spec.template` Rollout-а в кластері — теж `1.3.0`. `abort` не змінював `spec`, лише статус і масштаб ReplicaSet-ів, якими керує контролер Rollouts. Розбіжності немає.
- **Health = Degraded.** Здоров'я Rollout-а Argo CD бере зі `status` (вбудована health-перевірка для `argoproj.io/Rollout`). Скасований реліз — це стан, коли бажаний стан (`1.3.0` на всіх подах) **не досягнуто** і контролер відмовився його досягати. Тому Degraded, хоча всі 4 поди працюють і застосунок повністю доступний на `1.2.0`.

Тобто кластер працює на старій версії, а Git досі «хоче» нову. Цю суперечність треба закрити в Git, інакше наступна синхронізація чи рестарт контролера не знімуть Degraded, а `retry` почне реліз `1.3.0` знову.

### 6.3. Відкат через Git

```powershell
git switch -c revert-1.3.0 main/main
git revert --no-edit <коміт release 1.3.0>     # або merge-коміт PR: git revert -m 1 <merge-коміт>
git push -u main revert-1.3.0
# PR -> Merge
argocd app get booking-hotel --refresh
argocd app history booking-hotel
```

Після синхронізації `spec.template` знову має `1.2.0`, тобто збігається з **поточним stable-ReplicaSet**. Argo Rollouts розпізнає це як повернення до stable і не проходить кроки canary: Rollout одразу стає `✔ Healthy`, поди не перезапускаються. Argo CD: **Synced / Healthy**.

**Чому не `kubectl argo rollouts undo` або `argocd app rollback`:**

- `undo` змінює `spec.template` у кластері → Argo CD бачить розбіжність з Git → `selfHeal` повертає `1.3.0`, і реліз починається знову;
- `argocd app rollback` не працює з увімкненою автосинхронізацією;
- `git revert` лишає в історії, хто, коли й чому скасував реліз, і Git знову описує те, що реально працює.

## 7. Пояснення кожного файлу

### Нові файли

| Файл | Для чого | Що в ньому |
|---|---|---|
| `argocd-apps/argo-rollouts.yaml` | встановлення контролера Argo Rollouts з Git (п. 1a) | Application: Helm-чарт `argo-rollouts` `2.43.8` з `https://argoproj.github.io/argo-helm`, `valuesObject` (1 репліка контролера, дашборд увімкнено), namespace `argo-rollouts`, `prune` + `selfHeal`, `CreateNamespace`, `ServerSideApply` (великий CRD), sync-wave `-1` |
| `helm/booking-hotel/templates/_api-pod.tpl` | один шаблон пода для Deployment і Rollout, без дублювання | `define "booking-hotel.apiPodTemplate"`: мітки (з `version` = тег образу), анотації `checksum/config` і `checksum/secret`, контейнер `api` (образ, порт, `envFrom` ConfigMap + Secret, ресурси, startup/liveness/readiness проби, `preStop: sleep 5`). Перенесено з `api-deployment.yaml` без змін |
| `helm/booking-hotel/templates/api-rollout.yaml` | Rollout замість Deployment (п. 2) | рендериться, лише коли `api.rollout.enabled: true`; `fail`, якщо `replicaCount < 4`; `kind: Rollout`, ті самі ім'я, мітки, `selector`, `replicas`, `revisionHistoryLimit` і `template` (`_api-pod.tpl`), що в Deployment; `strategy` з `api.rollout.strategy` через `toYaml` |
| `docs/DEVOPS-LAB6-ROLLOUTS.md` | документ для здачі | цей файл |

### Змінені файли

| Файл | Що змінено і навіщо |
|---|---|
| `helm/booking-hotel/templates/api-deployment.yaml` | обгорнуто в `{{- if not .Values.api.rollout.enabled }}`: Deployment і Rollout не існують одночасно (той самий selector — два контролери воювали б за поди). Шаблон пода замінено на `include "booking-hotel.apiPodTemplate"`. Рендер з `enabled: false` — той самий, що раніше |
| `helm/booking-hotel/values.yaml` | новий блок `api.rollout`: `enabled: false` (dev/prod з Лаб. №4 лишаються на Deployment) і `strategy.canary` — `maxSurge: 1`, `maxUnavailable: 0` і 6 кроків (`setWeight` 25/50/75, `pause: {}`, дві `pause: {duration: 30s}`) з коментарями про співвідношення подів |
| `helm/booking-hotel/values-minikube.yaml` | `api.replicaCount: 2 → 4`, `api.rollout.enabled: true`. Рядок `api.image.tag` — те, що змінюється при кожному релізі |
| `helm/booking-hotel/Chart.yaml` | `version: 0.2.0 → 0.3.0` (новий шаблон і параметр), опис «Лаб. №4–6». `appVersion` не змінено |
| `helm/booking-hotel/templates/NOTES.txt` | якщо Rollout увімкнено — підказка з командами `get rollout --watch`, `promote`, `abort`; у підсумковому рядку видно, Rollout чи Deployment |
| `helm/booking-hotel/README.md` | у структуру чарту додано `_api-pod.tpl` і `api-rollout.yaml`, у таблицю параметрів — `api.rollout.enabled` і `api.rollout.strategy` |
| `argocd-apps/booking-hotel.yaml` | sync-wave `0` (після контролера); `PruneLast=true` — старий Deployment видаляється останнім, коли поди Rollout уже Ready (перехід без простою); `retry` з експоненційною паузою — на випадок, коли CRD Rollout ще не встановлено |

**Що не змінювалось:** `bootstrap/root.yaml` (root і так підхоплює всі файли з `argocd-apps/`), Service `booking-hotel-api` (його selector однаково вибирає поди Deployment і Rollout), код застосунку, `.github/workflows/ci.yml`. Зміни лише в `helm/`, `argocd-apps/` і `docs/`, тож CI не збирає образ на цей PR (фільтр шляхів з Лаб. №5).

## 8. Захист: лайв-демонстрація

**Підготовка (до захисту):**

1. Docker Desktop → `minikube start`.
2. Образи `1.2.0` і `1.3.0` у GHCR (розд. 5.1). Якщо після захисту потрібно повторити, підійде будь-який наявний тег, відмінний від поточного stable (`1.0.0` … `1.3.0`).
3. Термінали: port-forward Argo CD, `get rollout --watch`, цикл запитів `traffic` (розд. 5.1).
4. Вихідний стан: `booking-hotel` — Synced / Healthy, Rollout — 4 поди stable.

**Хід демонстрації:**

| # | Дія | Що показати |
|---|---|---|
| 1 | Argo CD UI: `root` → `argo-rollouts` і `booking-hotel` | контролер встановлено з Git; у дереві `booking-hotel` — Rollout замість Deployment |
| 2 | `values-minikube.yaml` і `values.yaml` | тег образу, `rollout.enabled`, кроки canary; пояснити вибір canary (розд. 4.2) |
| 3 | Зміна тега → PR → Merge → Refresh | Argo CD синхронізує, Rollout стартує |
| 4 | Ручна пауза | CLI: Step 1/6, 1 : 3; цикл запитів: обидві версії; Argo CD: Synced / Suspended |
| 5 | `promote` | 50 % → 30 с → 75 % → 30 с → 100 %; цикл запитів: лише нова версія; Healthy |
| 6 | Ще один реліз → ручна пауза → `abort` | canary → 0, усі запити на stable; Argo CD: Synced / Degraded; пояснити (розд. 6.2) |
| 7 | `git revert` → PR → Merge → Refresh | Rollout Healthy без перезапуску подів; `argocd app history` |

## 9. Типові помилки

| Симптом | Причина | Рішення |
|---|---|---|
| `booking-hotel`: `the server could not find the requested resource` / `no matches for kind "Rollout"` | CRD ще не встановлено | дочекатися `argo-rollouts` Healthy; `retry` повторить сам або Sync вручну |
| `argo-rollouts`: `metadata.annotations: Too long` | client-side apply великого CRD | `ServerSideApply=true` |
| `kubectl argo rollouts`: `unknown command "argo"` | плагіна немає в PATH або файл названо інакше | `kubectl-argo-rollouts.exe` у теці з PATH |
| Рендер падає: `потрібно api.replicaCount >= 4` | Rollout увімкнено при 2 репліках | `replicaCount: 4` |
| Rollout одразу 100 %, без пауз | перше створення Rollout-а (stable ще немає) або повернення на образ stable | так і має бути; кроки — лише при зміні `spec.template` на нову версію |
| Після `undo` / `kubectl argo rollouts set image` версія повертається | зміна `spec` у кластері → `selfHeal` повертає стан із Git | змінювати тег лише в Git |
| Після `abort` Degraded не зникає | Git досі описує скасовану версію | `git revert` релізного коміту |
| У циклі запитів лише одна версія | keep-alive з'єднання тримається одного пода | новий `curl` на кожен запит (як у прикладі) |
| `ImagePullBackOff` на canary-поді | тег ще не опубліковано в GHCR | дочекатися CI з git-тегу; `abort` → revert |

## 10. Питання до захисту

- **Що таке progressive delivery?** Реліз, який виходить поступово й під контролем: спершу на частину подів або користувачів, з перевірками на кожному кроці та можливістю зупинитися чи скасувати. Звичайний `RollingUpdate` замінює поди до кінця, і зупинити його на «25 %» для перевірки не можна.
- **Canary vs blue-green vs rolling update.**
  - Rolling update (Deployment) — заміна подів по одному до 100 %, без пауз і ручних рішень.
  - Canary — нова версія отримує частку трафіку (25 → 50 → 75 → 100 %), між кроками паузи й перевірки.
  - Blue-green — дві повні копії; трафік перемикається одразу на 100 %, preview-сервіс дає перевірити нову версію до перемикання.
- **Чому canary в цьому проєкті** — розд. 4.2.
- **Як рахується вага без Ingress чи mesh?** Кількістю подів: Service розподіляє з'єднання між усіма подами, тож 1 под з 4 ≈ 25 % запитів. Точна вага (наприклад, 5 %) потребує `trafficRouting`: Ingress NGINX, Istio, SMI.
- **`pause: {}` і `pause: {duration: 30s}`.** Перша чекає ручного `promote` безстроково, друга продовжує реліз сама через 30 с.
- **Що роблять `promote`, `abort`, `retry`?**
  - `promote` — зняти поточну паузу;
  - `promote --full` — пропустити всі кроки;
  - `abort` — повернути весь трафік і поди на stable, реліз позначено скасованим;
  - `retry` — почати скасований реліз заново.

  Усі вони змінюють статус Rollout-а, а не `spec`, тому не конфліктують з Argo CD.
- **Чому Synced / Degraded після abort?** Sync порівнює маніфести, а вони збігаються з Git. Health читається зі статусу Rollout-а, а той «скасований». Розд. 6.2.
- **Чому відкат через Git?** Git — джерело правди: поки в ньому `1.3.0`, Argo CD вважає `1.3.0` бажаним станом. `undo` перетре `selfHeal`. Revert лишає історію.
- **Як Argo CD знає здоров'я Rollout-а?** У нього вбудовані health-перевірки для CRD Argo Rollouts: `Paused` → Suspended, в процесі → Progressing, aborted → Degraded, завершено → Healthy. В інтерфейсі доступні дії над Rollout: Resume, Abort, Retry, Restart, Promote-Full.
- **Що таке sync-wave і `PruneLast`?**
  - sync-wave — порядок синхронізації ресурсів: менше число — раніше. Тут контролер (`-1`) іде перед застосунком (`0`).
  - `PruneLast` — видаляти зайві ресурси наприкінці синхронізації, коли нові вже Healthy. Так старий Deployment живе, доки поди Rollout не стануть Ready.
- **Що з міграціями БД під час canary?** Міграції застосовуються першим canary-подом до спільної БД, і stable-версія працює з новою схемою. Тому зміни схеми мають бути зворотно сумісними (expand/contract). `abort` не відкочує схему.
- **Rollout і Deployment одночасно з одним selector?** Не можна: два контролери керували б одними подами. Тому в чарті рендериться рівно один з двох об'єктів.
