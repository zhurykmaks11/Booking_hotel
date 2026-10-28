# GitOps: розгортання через Argo CD (DevOps, Лаб. №5)

Кластер minikube отримує стан застосунку **з Git**, а не з команд `helm` чи `kubectl`. Argo CD стежить за гілкою `main` репозиторію `Booking_hotel`, рендерить Helm-чарт з Лаб. №4 і синхронізує кластер з тим, що закомічено. Будь-яка зміна — тег образу, кількість реплік, змінна оточення — це коміт і `git push`.

## 1. Репозиторій конфігурації

Конфігурацію винесено в той самий репозиторій, що й застосунок.

```
Booking_hotel/
├── bootstrap/
│   └── root.yaml                  # кореневий Application, застосовується вручну один раз
├── argocd-apps/                   # Application-и, якими керує root
│   └── booking-hotel.yaml
└── helm/
    └── booking-hotel/             # чарт з Лаб. №4
        └── values-minikube.yaml   # значення для цього середовища (джерело правди)
```

Чарт лишився в `helm/booking-hotel/`, як у Лаб. №4: `charts/` з методички — лише рекомендація, а шлях задається в `spec.source.path`.

**CI не збирає образ на зміни конфігурації.** Job `changes` у `.github/workflows/ci.yml` (`dorny/paths-filter`) визначає, чи змінився код. Якщо змінено лише `helm/`, `argocd-apps/`, `bootstrap/`, `k8s/`, `docs/` або `*.md`, кроки збірки й публікації образу пропускаються.

Фільтр зроблено на рівні кроків, а не `on.push.paths-ignore`. На `main` є обов'язкові перевірки PR: пропущений через `paths-ignore` workflow лишив би їх у стані «Expected — Waiting», і PR неможливо було б змерджити. Git-тег `vX.Y.Z` збирає образ завжди.

**Секрети.** У чарт додано параметр `existingSecret`. Якщо його задано, шаблон `secret.yaml` не рендериться, а Deployment-и API і Postgres беруть `POSTGRES_PASSWORD` і `DATABASE_URL` з Secret, створеного вручну. Пароль не потрапляє в Git, а Argo CD не видаляє цей Secret навіть із `prune`, бо він створений не з Git.

```yaml
# templates/secret.yaml
{{- if not .Values.existingSecret }}
... Secret ...
{{- end }}

# _helpers.tpl
{{- define "booking-hotel.secretName" -}}
{{- default (printf "%s-secret" (include "booking-hotel.fullname" .)) .Values.existingSecret }}
{{- end }}
```

**`values-minikube.yaml`:**
- `api.replicaCount: 2`, `api.image.tag: "1.0.0"`, `pullPolicy: IfNotPresent`;
- `existingSecret: booking-hotel-db-secret`;
- `hooks.preUpgradeDbCheck.enabled: false`, `tests.enabled: false`.

Чому хук вимкнено: Argo CD виконує Helm-хуки `pre-install` і `pre-upgrade` як **PreSync**, тобто перед створенням ресурсів, зокрема й під час першої синхронізації. Postgres тоді ще немає, перевірка БД завжди падала б, і синхронізація ніколи б не завершилась. Тести Helm (`helm.sh/hook: test`) Argo CD не запускає.

Версія чарта: `0.1.1` → `0.2.0` (новий параметр `existingSecret`), `appVersion` без змін.

## 2. Образ застосунку

`GET /version` повертає `APP_VERSION`, вшиту в образ під час збірки (`ARG APP_VERSION` у Dockerfile, з Лаб. №3). Образи `ghcr.io/zhurykmaks11/booking-hotel-api:1.0.0` і `:1.1.0` публікує CI з git-тегів `v1.0.0` і `v1.1.0`. Пакет у GHCR публічний.

```json
{"version":"1.0.0","instanceId":"booking-hotel-api-...","environment":"production"}
```

## 3. Встановлення Argo CD

```powershell
minikube start
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd get pods -w        # дочекатися Running усіх подів
```

**CLI для Windows:** `argocd-windows-amd64.exe` зі сторінки релізів, перейменувати в `argocd.exe` і покласти в теку з PATH.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null
Invoke-WebRequest https://github.com/argoproj/argo-cd/releases/latest/download/argocd-windows-amd64.exe -OutFile "$env:USERPROFILE\bin\argocd.exe"
$env:Path += ";$env:USERPROFILE\bin"
argocd version --client
```

**Вхід:**

```powershell
kubectl -n argocd port-forward svc/argocd-server 8080:443     # окремий термінал, не закривати
argocd admin initial-password -n argocd
argocd login localhost:8080 --username admin --insecure
argocd account update-password
kubectl -n argocd delete secret argocd-initial-admin-secret
```

Інтерфейс: `https://localhost:8080`. Сертифікат самопідписаний, браузер попередить: «Додатково → Перейти». Репозиторій публічний, тож `argocd repo add` не потрібен.

## 4. Застосунок під керуванням Argo CD

- **`argocd-apps/booking-hotel.yaml`** — Application з джерелом `helm/booking-hotel` + `values-minikube.yaml`, призначенням namespace `booking-hotel`, `automated.prune: true` і `CreateNamespace=true`. Назва Application стає назвою Helm-релізу, тож об'єкти мають ті самі імена, що в Лаб. №4: `booking-hotel-api`, `-postgres`, `-redis`.
- **`bootstrap/root.yaml`** — кореневий Application (App of Apps), що стежить за каталогом `argocd-apps/` з `prune` і `selfHeal`. Новий застосунок чи компонент кластера додається одним файлом у `argocd-apps/`.

**Порядок:**

```powershell
# 1) Secret — вручну, до першої синхронізації (пароль ніде в Git не зберігається)
kubectl create namespace booking-hotel
kubectl -n booking-hotel create secret generic booking-hotel-db-secret `
  --from-literal=POSTGRES_PASSWORD=<пароль> `
  --from-literal=DATABASE_URL="postgresql://postgres:<пароль>@booking-hotel-postgres:5432/hotel_booking?schema=public"

# 2) конфігурація — у main (через PR або прямий push)
git add bootstrap argocd-apps helm docs .github
git commit -m "feat(gitops): deploy booking-hotel via Argo CD"
git push

# 3) єдиний ручний apply
kubectl apply -f bootstrap/root.yaml
argocd app list                       # root і booking-hotel: Synced, Healthy
argocd app get booking-hotel
kubectl -n booking-hotel get pods
helm list -n booking-hotel            # порожньо: Argo CD лише рендерить шаблони (helm template), реліз Helm не створюється
```

`helm list` порожній, бо Argo CD не викликає `helm install`. Він рендерить чарт і сам застосовує маніфести, а стан зберігає в об'єкті Application, а не в Secret-ах `sh.helm.release.v1.*`.

## 5. Оновлення через Git

```powershell
# у helm/booking-hotel/values-minikube.yaml: tag: "1.0.0" -> tag: "1.1.0"
git commit -am "Release booking-hotel 1.1.0"
git push

argocd app get booking-hotel --refresh     # не чекати опитування Git (до 3 хв)
kubectl -n booking-hotel get pods -w

kubectl -n booking-hotel port-forward svc/booking-hotel-api 8081:80
curl.exe -s localhost:8081/version          # "version":"1.1.0"
```

В інтерфейсі видно таку послідовність: Refresh → `OutOfSync` → автоматична синхронізація → нові поди в дереві → `Synced` / `Healthy`. У реальному проєкті коміт зі зміною тега робить CI після збірки образу.

## 6. Дрейф, Health і відкат

**a) Дрейф.** Поки `selfHeal` вимкнено:

```powershell
kubectl -n booking-hotel scale deployment booking-hotel-api --replicas=5
argocd app get booking-hotel          # OutOfSync, але реплік лишається 5
```

Розкоментуй `selfHeal: true` в `argocd-apps/booking-hotel.yaml` і запуш: root застосує зміну сам. Після повтору `kubectl scale` Argo CD поверне 2 репліки за кілька секунд.

**b) Synced, але Degraded.** Встанови тег `9.9.9` (неіснуючий) і запуш:

```powershell
argocd app get booking-hotel --refresh
# Sync Status:   Synced     — маніфест у кластері такий самий, як у Git
# Health Status: Degraded / Progressing — новий под в ImagePullBackOff
kubectl -n booking-hotel get pods
```

Старі поди продовжують працювати завдяки `maxUnavailable: 0`, тож застосунок лишається доступним.

**c) Відкат.** Повертаємо опис у Git, а не кластер:

```powershell
git log --oneline
git revert <коміт з 9.9.9>
git push
argocd app get booking-hotel --refresh
argocd app history booking-hotel      # кожна синхронізація прив'язана до коміту
curl.exe -s localhost:8081/version
```

`argocd app rollback` працює лише з вимкненою автосинхронізацією, інакше Argo CD одразу поверне стан із Git. Тому відкат робиться комітом.

## 7. Захист: лайв-демонстрація

Підготовка: Docker Desktop, `minikube start`, port-forward до Argo CD (8080) і застосунку (8081), образи `1.0.0` і `1.1.0` у GHCR.

1. Інтерфейс Argo CD: `root` → `booking-hotel` → дерево об'єктів, `Synced` / `Healthy`.
2. Зміна тега → commit → push → Refresh → нова версія в `curl /version`.
3. `kubectl scale` → Argo CD повертає репліки (`selfHeal`).
4. Неіснуючий тег → `Synced` + `Degraded` → `git revert` → `Healthy`.
5. На прохання викладача: інше значення (`api.replicaCount`, `config.syntheticDelayMs`) → commit → push → Refresh.

**Чому push у `main` повільний.** На `main` налаштовано обов'язкові перевірки. Якщо прямий push відхиляється, кожна зміна йде через PR і чекає CI: lint + тести, приблизно 1–2 хв; образ не збирається. Щоб на захисті пушити напряму, власник репозиторію може дозволити собі обхід правила: Settings → Branches (або Rules) → правило для `main` → дозволити bypass для адміністраторів.

## 8. Типові помилки

| Симптом | Причина | Рішення |
|---|---|---|
| `ComparisonError: repository not found` | помилка в `repoURL` або приватний репозиторій без `argocd repo add` | перевірити `repoURL`, зробити репо публічним або додати його |
| `ImagePullBackOff` | приватний пакет у GHCR або тег, якого немає | зробити пакет публічним, перевірити тег |
| `values-minikube.yaml: no such file` | `valueFiles` шукаються відносно `path` чарта | `valueFiles: [values-minikube.yaml]`, сам файл у `helm/booking-hotel/` |
| `secret "booking-hotel-db-secret" not found`, поди в `CreateContainerConfigError` | Secret не створено вручну | `kubectl -n booking-hotel create secret generic booking-hotel-db-secret ...` |
| Синхронізація зависла на PreSync | увімкнено хук `pre-upgrade` (Argo CD виконує його до створення Postgres) | `hooks.preUpgradeDbCheck.enabled: false` |
| Application не з'являється | дочірній Application не в namespace `argocd` | `metadata.namespace: argocd` |
| Зміна не приїхала | push не в ту гілку (`targetRevision: main`) або ще не минув інтервал опитування | Refresh |
| Зміни перетираються | ручний `helm install` / `kubectl apply` поряд з Argo CD — два джерела правди | керувати лише через Git |

## 9. Питання до захисту

- **Що таке GitOps?** Git — єдине джерело правди про бажаний стан системи. Агент у кластері (Argo CD) сам **витягує** (pull) зміни з Git і приводить до них кластер. CI більше не має доступу до кластера (push-модель).
- **Sync Status і Health Status.**
  - Sync — чи збігається стан кластера з Git (`Synced` / `OutOfSync`).
  - Health — чи працюють ресурси (`Healthy` / `Progressing` / `Degraded` / `Missing`).
  - Вони незалежні: зламаний тег дає `Synced` + `Degraded`.
- **`prune`** — видаляти з кластера ресурси, яких більше немає в Git.
- **`selfHeal`** — повертати ручні зміни в кластері до стану з Git (дрейф).
- **App of Apps** — кореневий Application `root` керує іншими Application-ами з каталогу `argocd-apps/`. Вручну застосовується лише він, усе інше додається комітом.
- **Чому відкат через `git revert`, а не `argocd app rollback`?** З автосинхронізацією Argo CD одразу поверне стан із Git. До того ж revert лишає слід в історії: хто, коли і що відкотив.
- **Як Argo CD працює з Helm?** Рендерить чарт (`helm template`) з `valueFiles` і застосовує маніфести сам. Реліз Helm не створюється (`helm list` порожній). Хуки Helm перетворюються на хуки синхронізації Argo CD: `pre-install`/`pre-upgrade` → PreSync, `post-*` → PostSync.
- **Звідки Argo CD бере зміни?** Опитує репозиторій приблизно кожні 3 хв (або webhook); Refresh змушує перевірити одразу.
