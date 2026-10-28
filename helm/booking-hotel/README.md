# Helm-чарт `booking-hotel` — Лабораторна робота №4 (Технології DevOps)

Чарт пакує Hotel Booking System: API на NestJS + Prisma, PostgreSQL 16 і Redis 7. Він створює той самий набір об'єктів Kubernetes, що й маніфести з [`k8s/`](../../k8s/) лабораторної №3, але всі імена, теги, репліки, ресурси й параметри задаються через values.

- **Інструменти:** Helm v4.3.1 (чарти `apiVersion: v2`, сумісні з Helm 3), minikube v1.39.0, Kubernetes v1.37.0.

**Швидкий старт:**

```powershell
# dev (за замовчуванням)
helm install booking-hotel helm/booking-hotel -n booking-hotel --create-namespace -f helm/booking-hotel/values-dev.yaml

# prod (пароль лише з командного рядка)
helm install booking-hotel helm/booking-hotel -n booking-hotel --create-namespace -f helm/booking-hotel/values-prod.yaml --set secrets.postgresPassword=<пароль>
```

---

## Зміст

1. [Підготовка середовища](#1-підготовка-середовища)
2. [Структура чарта](#2-структура-чарта)
3. [Перенесення маніфестів у шаблони](#3-перенесення-маніфестів-у-шаблони)
4. [values.yaml](#4-valuesyaml)
5. [Спільні шаблони та NOTES.txt](#5-спільні-шаблони-та-notestxt)
6. [Два середовища](#6-два-середовища)
7. [Перевірка та встановлення](#7-перевірка-та-встановлення)
8. [Життєвий цикл релізу](#8-життєвий-цикл-релізу)
9. [Завдання на вибір: хук і тест](#9-завдання-на-вибір-хук-і-тест)
10. [Відповідність вимогам до здачі](#10-відповідність-вимогам-до-здачі)
11. [Питання до захисту](#11-питання-до-захисту)

---

## 1. Підготовка середовища

**Що вимагалось:**
- встановити Helm і запустити minikube;
- перевірити, що маніфести лабораторної №3 працюють;
- видалити їх, щоб уникнути конфлікту імен.

**Що зроблено:**

```powershell
winget install Helm.Helm
helm version                                   # v4.3.1
minikube start --driver=docker --cpus=2 --memory=4096
minikube addons enable metrics-server
minikube addons enable ingress
kubectl get nodes                              # minikube   Ready

kubectl apply -f k8s/                          # лаб. №3: усі поди 1/1 Running
# видалення лаб. №3 (спершу Deployment-и, щоб PVC звільнився):
kubectl delete -n booking-hotel deployment/booking-api deployment/postgres deployment/redis
kubectl delete -n booking-hotel service/booking-api service/postgres service/redis ingress/booking-api
kubectl delete -f k8s/01-configmap.yaml -f k8s/02-secret.yaml -f k8s/10-postgres-pvc.yaml
```

Без видалення лабораторної №3 prod-реліз не встановився б: обидва Ingress претендують на хост `booking-hotel.local`, і ingress-nginx відхиляє дубль.

## 2. Структура чарта

**Що вимагалось:**
- каталог чарта в репозиторії;
- `Chart.yaml` з `name`, `description`, `version`, `appVersion`;
- пояснення різниці між `version` і `appVersion`.

```
helm/booking-hotel/
├── Chart.yaml              # name, description, version, appVersion
├── values.yaml             # значення за замовчуванням (= dev)
├── values-dev.yaml         # середовище розробки
├── values-prod.yaml        # продакшн
├── values-minikube.yaml    # minikube під керуванням Argo CD (Лаб. №5)
├── .helmignore             # що не потрапляє в пакет
├── README.md               # цей файл
└── templates/
    ├── _helpers.tpl                       # іменовані шаблони
    ├── NOTES.txt                          # підказка після встановлення
    ├── configmap.yaml
    ├── secret.yaml
    ├── postgres-pvc.yaml                  # якщо postgres.persistence.enabled
    ├── postgres-deployment.yaml
    ├── postgres-service.yaml
    ├── redis-deployment.yaml              # якщо redis.enabled
    ├── redis-service.yaml                 # якщо redis.enabled
    ├── api-deployment.yaml
    ├── api-service.yaml
    ├── api-ingress.yaml                   # якщо ingress.enabled
    ├── hooks/pre-upgrade-db-check.yaml    # хук pre-upgrade
    └── tests/test-connection.yaml         # тест релізу
```

### `version` і `appVersion`

| Поле | Значення | Що означає | Коли змінюється |
|---|---|---|---|
| `version` | `0.2.0` | версія **чарта**, тобто пакування: шаблони, values, хуки | при будь-якій зміні в `helm/booking-hotel/` |
| `appVersion` | `1.1.0` | версія **застосунку**, тобто тег образу API за замовчуванням | з новим релізом коду (git-тег `vX.Y.Z` → образ `X.Y.Z`) |

Приклад із роботи: виправлення міток подів Postgres і Redis змінило `version` `0.1.0` → `0.1.1`, а `appVersion` лишився `1.1.0`, бо код застосунку не змінювався. Якщо `api.image.tag` порожній, використовується `appVersion`.

## 3. Перенесення маніфестів у шаблони

**Що вимагалось:**
- кожен маніфест окремим файлом у `templates/`;
- значення з `.Values`;
- імена з імені релізу;
- значення Secret — з values.

| Лаб. №3 (`k8s/`) | Шаблон | Об'єкт для релізу `booking-hotel` |
|---|---|---|
| `00-namespace.yaml` | — (`helm install --create-namespace`) | `booking-hotel` |
| `01-configmap.yaml` | `configmap.yaml` | `booking-hotel-config` |
| `02-secret.yaml` | `secret.yaml` | `booking-hotel-secret` |
| `10-postgres-pvc.yaml` | `postgres-pvc.yaml` | `booking-hotel-postgres-data` |
| `11-postgres-deployment.yaml` | `postgres-deployment.yaml` | `booking-hotel-postgres` |
| `12-postgres-service.yaml` | `postgres-service.yaml` | `booking-hotel-postgres` |
| `20-redis-deployment.yaml` | `redis-deployment.yaml` | `booking-hotel-redis` |
| `21-redis-service.yaml` | `redis-service.yaml` | `booking-hotel-redis` |
| `30-api-deployment.yaml` | `api-deployment.yaml` | `booking-hotel-api` |
| `31-api-service.yaml` | `api-service.yaml` | `booking-hotel-api` |
| `32-api-ingress.yaml` | `api-ingress.yaml` | `booking-hotel-api` |

**Що змінилося порівняно з лабораторною №3:**

- **Жорстко прописаних значень немає.** Образ береться з `{{ include "booking-hotel.apiImage" . }}` (`repository:tag`, тег за замовчуванням дорівнює `appVersion`), репліки — з `{{ .Values.api.replicaCount }}`, ресурси — з `toYaml .Values.api.resources`.
- **Імена будуються з імені релізу.**
  - реліз `booking-hotel` → `booking-hotel-api`;
  - реліз `test` → `test-booking-hotel-api`.

  Тож чарт можна встановити двічі в один кластер. NodePort не фіксований (`api.service.nodePort: ""`), Kubernetes видає вільний порт.
- **Залежні адреси обчислюються.** `REDIS_URL` = `redis://<fullname>-redis:6379`, `DATABASE_URL` = `postgresql://<user>:<password>@<fullname>-postgres:5432/<db>`.
- **Secret.** `stringData` береться з `.Values.secrets.postgresPassword` через `required`: без пароля рендер зупиняється з помилкою. У самому шаблоні паролів немає.
- **Автоматичний rolling restart.** Deployment API має анотації `checksum/config` і `checksum/secret`, тож зміна ConfigMap або Secret сама запускає rolling update (у лабораторній №3 для цього потрібен був `kubectl rollout restart`).
- **Те, що лишилось як у лабораторній №3:**
  - проби `startupProbe` / `livenessProbe` (`/health/live`) / `readinessProbe` (`/health`);
  - `RollingUpdate` з `maxUnavailable: 0`;
  - `preStop: sleep 5`;
  - `Recreate` і `PGDATA` для Postgres.

## 4. `values.yaml`

**Що вимагалось:**
- винести образ, репліки, сервіс, ресурси, конфігурацію, Ingress;
- значення за замовчуванням мають відповідати dev;
- прапорці `enabled` для необов'язкових об'єктів.

| Параметр | За замовчуванням | Опис |
|---|---|---|
| `nameOverride` / `fullnameOverride` | `""` | перевизначення імені об'єктів |
| `api.replicaCount` | `1` | репліки API |
| `api.image.repository` | `ghcr.io/zhurykmaks11/booking-hotel-api` | репозиторій образу |
| `api.image.tag` | `""` (→ `appVersion`) | тег образу, не `latest` |
| `api.image.pullPolicy` | `IfNotPresent` | політика завантаження |
| `api.service.type` / `port` / `nodePort` | `NodePort` / `80` / `""` | Service API |
| `api.containerPort` | `3000` | порт контейнера |
| `api.resources` | req `50m/128Mi`, lim `300m/384Mi` | ресурси API |
| `api.rollingUpdate.maxSurge` / `maxUnavailable` | `1` / `0` | rolling update без простою |
| `config.nodeEnv` | `development` | `NODE_ENV` |
| `config.port` | `3000` | `PORT` |
| `config.syntheticDelayMs` | `0` | `SYNTHETIC_DELAY_MS` |
| `ingress.enabled` | `false` | створювати Ingress |
| `ingress.className` / `host` | `nginx` / `booking-hotel.local` | параметри Ingress |
| `postgres.image.repository` / `tag` | `postgres` / `16` | образ БД |
| `postgres.database` / `user` | `hotel_booking` / `postgres` | БД і користувач |
| `postgres.persistence.enabled` | `true` | PVC (`false` → `emptyDir`) |
| `postgres.persistence.size` / `storageClass` | `1Gi` / `""` | том |
| `postgres.resources` | req `100m/256Mi`, lim `500m/512Mi` | ресурси БД |
| `redis.enabled` | `true` | Redis (`false` → API без кешу) |
| `redis.image.repository` / `tag` | `redis` / `7-alpine` | образ Redis |
| `redis.maxMemory` | `128mb` | ліміт пам'яті Redis |
| `redis.resources` | req `50m/64Mi`, lim `250m/192Mi` | ресурси Redis |
| `existingSecret` | `""` | ім'я Secret, створеного вручну; якщо задано, `secret.yaml` не рендериться (Лаб. №5, Argo CD) |
| `secrets.postgresPassword` | `dev-only-change-me` (навчальний) | пароль БД → Secret (коли `existingSecret` порожній) |
| `hooks.preUpgradeDbCheck.enabled` | `true` | хук pre-upgrade |
| `tests.enabled` / `tests.image` | `true` / `busybox:1.36` | тест релізу |

## 5. Спільні шаблони та NOTES.txt

**Що вимагалось:** іменовані шаблони для імені та міток у `_helpers.tpl`, їх підключення через `include` і інструкція в `NOTES.txt`.

| Шаблон у `_helpers.tpl` | Призначення |
|---|---|
| `booking-hotel.name` | ім'я чарта (`nameOverride`) |
| `booking-hotel.fullname` | повне ім'я з імені релізу |
| `booking-hotel.componentName` | `<fullname>-<компонент>`: `-api`, `-postgres`, `-redis` |
| `booking-hotel.chart` | мітка `helm.sh/chart: booking-hotel-0.1.1` |
| `booking-hotel.selectorLabels` | незмінні мітки для `selector`: name, instance, component |
| `booking-hotel.labels` | повний набір: + chart, version (тег образу API), managed-by, part-of |
| `booking-hotel.stablePodLabels` | мітки подів Postgres/Redis без version і chart |
| `booking-hotel.apiImage` | `repository:tag` образу API |
| `booking-hotel.databaseUrl` | рядок підключення до БД |

Усі шаблони об'єктів підключають їх через `include`, наприклад:

```yaml
labels:
  {{- include "booking-hotel.labels" (dict "ctx" $ "component" "api") | nindent 4 }}
```

`NOTES.txt` після `install` / `upgrade` виводить:
- як дочекатися подів;
- як відкрити застосунок: при вимкненому Ingress — `minikube service ... --url`, при увімкненому — hosts і `minikube tunnel`; запасний варіант — `kubectl port-forward`;
- команду `helm test`;
- кількість реплік, стан Ingress і `NODE_ENV`.

## 6. Два середовища

**Що вимагалось:**
- `values-dev.yaml` і `values-prod.yaml`, які відрізняються репліками, ресурсами, тегом образу та Ingress;
- показати різницю без встановлення;
- пояснити пріоритет значень.

| Параметр | dev | prod |
|---|---|---|
| `api.replicaCount` | 1 | 3 |
| `api.image.tag` | `1.1.0` | `1.0.0` |
| `api.resources` | req `50m/128Mi`, lim `300m/384Mi` | req `200m/256Mi`, lim `1/768Mi` |
| `ingress.enabled` | false | true |
| `config.nodeEnv` | development | production |
| `postgres.persistence.size` | 1Gi | 2Gi |
| пароль БД | навчальний з `values.yaml` | лише `--set secrets.postgresPassword=...` |

**Різниця без кластера.** У PowerShell 5 вивід треба записувати через `Out-File -Encoding utf8`: оператор `>` створює UTF-16, і git вважає такий файл двійковим.

```powershell
helm template booking-hotel helm/booking-hotel -n booking-hotel -f helm/booking-hotel/values-dev.yaml  | Out-File -Encoding utf8 rendered-dev.yaml
helm template booking-hotel helm/booking-hotel -n booking-hotel -f helm/booking-hotel/values-prod.yaml | Out-File -Encoding utf8 rendered-prod.yaml
git diff --no-index rendered-dev.yaml rendered-prod.yaml
```

Що видно в diff:
- `replicas`, образ, `resources`, `NODE_ENV`, `storage`;
- `checksum/config`;
- у prod додається документ Ingress.

`rendered-*.yaml` додано в `.gitignore`.

**Пріоритет значень** (від найнижчого до найвищого):

1. `values.yaml` чарта;
2. файли `-f` у порядку перелічення (правіший перемагає);
3. `--set` / `--set-string` / `--set-file`.

Об'єднання глибоке: з файлу береться лише те, що в ньому задано. Приклад з роботи: `-f values-prod.yaml --set postgres.persistence.size=1Gi` дав 3 репліки з prod-файлу і розмір тому з `--set`. При `helm upgrade` без `--reuse-values` значення збираються заново, а попередні `--set` не зберігаються.

## 7. Перевірка та встановлення

**Що вимагалось:**
- перевірити чарт;
- порівняти маніфести з лабораторною №3;
- встановити реліз у власний namespace;
- показати релізи, статус і значення;
- показати, де Helm зберігає стан.

```powershell
helm lint helm/booking-hotel                                          # 0 chart(s) failed
helm lint helm/booking-hotel -f helm/booking-hotel/values-prod.yaml   # 0 chart(s) failed

helm install booking-hotel helm/booking-hotel -n booking-hotel --create-namespace -f helm/booking-hotel/values-dev.yaml
# STATUS: deployed, REVISION: 1 + текст NOTES.txt

helm list -n booking-hotel
helm status booking-hotel -n booking-hotel
helm get values booking-hotel -n booking-hotel          # USER-SUPPLIED VALUES (з -f / --set)
helm get values booking-hotel -n booking-hotel --all    # COMPUTED VALUES (усі)
helm get manifest booking-hotel -n booking-hotel        # що реально застосовано
```

**Де Helm зберігає стан.** У namespace релізу, у Secret типу `helm.sh/release.v1`, по одному на кожну ревізію. Усередині лежить запакований (gzip + base64) опис релізу: чарт, values і маніфести. На цих Secret-ах працюють `helm history` і `helm rollback`.

```powershell
kubectl get secrets -n booking-hotel -l owner=helm
# sh.helm.release.v1.booking-hotel.v1   helm.sh/release.v1   1   2m40s
```

## 8. Життєвий цикл релізу

**Що вимагалось:**
- оновлення через `--set` і файлом іншого середовища;
- історія ревізій;
- відкат;
- видалення однією командою.

```powershell
# ревізія 2 — тег через --set
helm upgrade booking-hotel helm/booking-hotel -n booking-hotel -f helm/booking-hotel/values-dev.yaml --set api.image.tag=1.0.0 --description "dev: image 1.0.0 via --set"

# ревізія 3 — файл значень prod
helm upgrade booking-hotel helm/booking-hotel -n booking-hotel -f helm/booking-hotel/values-prod.yaml --set secrets.postgresPassword=dev-only-change-me --set postgres.persistence.size=1Gi --description "switch to prod values (chart 0.1.1)"

# історія і відкат (ревізія 4)
helm history booking-hotel -n booking-hotel
helm rollback booking-hotel 1 -n booking-hotel
helm history booking-hotel -n booking-hotel

# видалення
kubectl delete pod -n booking-hotel -l app.kubernetes.io/component=test
helm uninstall booking-hotel -n booking-hotel
kubectl get all,cm,secret,pvc,ingress,jobs -n booking-hotel     # лише configmap/kube-root-ca.crt
helm list -n booking-hotel                                     # порожньо
```

| Ревізія | Статус | Чарт | Що змінилося | `/version` |
|---|---|---|---|---|
| 4 | deployed | 0.1.0 | `Rollback to 1`: значення і шаблони ревізії 1, Ingress видалено | 1.1.0, development |
| 3 | superseded | 0.1.1 | 3 репліки, образ 1.0.0, більші ресурси, production, + Ingress; стабільні мітки Postgres/Redis | 1.0.0, production |
| 2 | superseded | 0.1.0 | лише тег образу API (1.0.0) → rolling update API | 1.0.0, development |
| 1 | superseded | 0.1.0 | встановлення dev: 1 репліка, 1.1.0, без Ingress | 1.1.0, development |

**Пояснення до історії:**
- **Відкат не переписує історію.** Він додає нову ревізію з конфігурацією обраної, а поточна стає `superseded`.
- **Відкат повертає і шаблони.** Разом зі значеннями повертаються й шаблони того чарта, тому ревізія 4 знову має чарт `0.1.0`.
- **Колонка `APP VERSION`.** В історії вона завжди показує `appVersion` з Chart.yaml (`1.1.0`), а не фактичний тег. Реальний тег показує мітка `app.kubernetes.io/version`.
- **Доступність.** Під час оновлень застосунок лишався доступним завдяки `maxUnavailable: 0`.
- **Що лишається після `uninstall`.** Лише системний ConfigMap `kube-root-ca.crt`, який Kubernetes створює в кожному namespace. Secret-и стану Helm видаляються разом з релізом.

## 9. Завдання на вибір: хук і тест

Обрано варіант «хук `pre-upgrade` + тест релізу `helm test`».

**Хук `pre-upgrade`** — `templates/hooks/pre-upgrade-db-check.yaml`. Це Job на `postgres:16`, який перед кожним `helm upgrade` виконує `pg_isready -h <fullname>-postgres`.

- **Якщо БД недоступна,** Job падає, і Helm скасовує оновлення, тож робочий реліз лишається недоторканим.
- **Анотації:**
  - `helm.sh/hook: pre-upgrade`;
  - `helm.sh/hook-weight: "0"`;
  - `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded` (після успіху Job видаляється).
- **При `helm rollback` хук не запускається:** для відкату є окремий тип `pre-rollback`.

```
kubectl get jobs -n booking-hotel -w
booking-hotel-pre-upgrade-db-check   Running              0/1   0s
booking-hotel-pre-upgrade-db-check   SuccessCriteriaMet   0/1   4s
booking-hotel-pre-upgrade-db-check   Complete             1/1   4s
```

**Тест релізу** — `templates/tests/test-connection.yaml`. Це Pod на `busybox:1.36` з `helm.sh/hook: test`.

- Він звертається до API через Service зсередини кластера і вважає тест пройденим, лише якщо `/health` повертає `"status":"UP"`.
- `hook-delete-policy: before-hook-creation`: Pod лишається після тесту, щоб `--logs` міг прочитати його логи. Тому перед `uninstall` його треба видалити окремо.

```
helm test booking-hotel -n booking-hotel --logs
Phase:          Succeeded
GET http://booking-hotel-api:80/health
{"status":"UP","database":"CONNECTED",...,"cache":{"redis":"CONNECTED",...}}
OK: реліз працює
```

## 10. Відповідність вимогам до здачі

| Вимога | Як виконано |
|---|---|
| Той самий застосунок і той самий набір об'єктів, що в лаб. №3 | таблиця в п. 3: ConfigMap, Secret, PVC, 3 Deployment-и, 3 Service-и, Ingress; namespace через `--create-namespace` |
| Жодного жорстко прописаного імені релізу, тега чи кількості реплік | імена з `booking-hotel.fullname`, тег з `api.image.tag` / `appVersion`, репліки з `api.replicaCount` |
| Встановлення на чистому кластері однією командою | `helm install booking-hotel helm/booking-hotel -n booking-hotel --create-namespace` |
| Реальні паролі у файлах значень не зберігаються | у `values.yaml` лише навчальний `dev-only-change-me`, у `values-prod.yaml` пароля немає, тільки `--set` |
| Чарт у репозиторії, параметри values таблицею, команди для обох середовищ | цей файл + розділ «Helm-чарт» у [`README.md`](../../README.md) |

## 11. Питання до захисту

**Що таке Helm, чарт, реліз, ревізія?**
- **Helm** — менеджер пакетів для Kubernetes.
- **Чарт** — пакет: шаблони маніфестів + значення + метадані.
- **Реліз** — конкретне встановлення чарта в кластер під іменем (`booking-hotel`).
- **Ревізія** — номер версії релізу, який зростає з кожним `upgrade` / `rollback`.

**Навіщо Helm, якщо є `kubectl apply -f k8s/`?**
- одні шаблони для різних середовищ (dev/prod різняться одним файлом значень);
- версіонування релізу з історією і відкатом однією командою;
- видалення всіх об'єктів однією командою;
- хуки й тести;
- пакування й публікація чарта (`helm package`, OCI-реєстр).

**Як працюють шаблони?**
- Шаблони пишуться на Go templates з бібліотекою функцій Sprig: `{{ .Values.x }}`, `include`, `toYaml`, `nindent`, `default`, `required`, `quote`.
- Вбудовані об'єкти: `.Values`, `.Release` (Name, Namespace), `.Chart` (Name, Version, AppVersion), `.Template`.
- `{{-` / `-}}` прибирають пробіли й переноси рядків зліва / справа.

**Навіщо `_helpers.tpl`?**
- Там визначаються іменовані шаблони (`define`), щоб не дублювати однаковий код (ім'я, мітки) в кожному маніфесті.
- Файли з `_` на початку Helm не рендерить як маніфести.

**Чому імена будуються з `.Release.Name`?** Щоб один чарт можна було встановити кілька разів в один кластер або namespace без конфліктів імен.

**`selectorLabels` проти `labels`?**
- `selector` у Deployment незмінний після створення, тому в ньому лише стабільні мітки (name, instance, component).
- Мітки, що змінюються (version, chart), стоять тільки на об'єктах і подах.
- У подах Postgres/Redis змінних міток немає зовсім, щоб оновлення API не перезапускало БД.

**Різниця `helm template`, `helm lint`, `--dry-run`?**
- `lint` — перевірка чарта на помилки та рекомендації.
- `template` — рендер маніфестів локально, без кластера.
- `install --dry-run=server` — рендер + перевірка сервером Kubernetes без створення об'єктів.

**`upgrade --install`, `--reuse-values`, `--atomic`?**
- `--install` встановлює реліз, якщо його ще немає.
- `--reuse-values` бере значення попередньої ревізії й накладає на них нові.
- `--atomic` / `--rollback-on-failure` автоматично відкочує реліз, якщо оновлення не вдалося.

**Що таке хуки і які бувають?**
- Хуки — об'єкти з анотацією `helm.sh/hook`, які Helm запускає в певний момент: `pre-install`, `post-install`, `pre-upgrade`, `post-upgrade`, `pre-rollback`, `post-rollback`, `pre-delete`, `post-delete`, `test`.
- Вони не є частиною релізу, тож `uninstall` їх не видаляє; за це відповідає `hook-delete-policy`.

**Залежності чарта?** Задаються в `Chart.yaml` → `dependencies` (наприклад `bitnami/postgresql`) і налаштовуються з батьківського values під ключем із назвою підчарта; `helm dependency update` завантажує їх у `charts/`. У цій роботі обрано інший варіант завдання.
