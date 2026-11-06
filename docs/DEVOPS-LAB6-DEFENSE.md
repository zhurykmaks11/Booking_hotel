# Інструкція до здачі: DevOps Лаб. №6 (Argo Rollouts, canary)

Покрокова шпаргалка для лайв-демонстрації. Повний опис, пояснення файлів і теорія — у [DEVOPS-LAB6-ROLLOUTS.md](DEVOPS-LAB6-ROLLOUTS.md).

**Що показується на захисті (п. 6 завдання):** реліз комітом → проміжний стан (CLI, Argo CD, дашборд) → `promote` → ще один реліз → `abort` → Synced / Degraded → відкат через Git.

**Версії:** перед захистом stable — `1.2.0`. На захисті реліз `1.3.0` (promote), потім реліз `1.4.0` (abort і відкат назад на `1.3.0`).

---

## Частина A. Один раз до захисту (вдома)

### A1. Опублікувати образи 1.2.0, 1.3.0, 1.4.0

CI збирає образ лише з git-тегу `vX.Y.Z`. `2794531` — коміт `main` з Лаб. №6 і №7 (хеш, бо гілка й remote обидва називаються `main`).

```powershell
cd D:\KURS4\Booking_Hotel\backend
git fetch main
git tag -a v1.2.0 2794531 -m "Release 1.2.0"
git tag -a v1.3.0 2794531 -m "Release 1.3.0"
git tag -a v1.4.0 2794531 -m "Release 1.4.0"
git push main v1.2.0 v1.3.0 v1.4.0
```

GitHub → **Actions**: три запуски CI з тегів, у кожному має пройти job публікації образу (кілька хвилин). Перевірка:

```powershell
docker manifest inspect ghcr.io/zhurykmaks11/booking-hotel-api:1.2.0 > $null; $?   # True
docker manifest inspect ghcr.io/zhurykmaks11/booking-hotel-api:1.3.0 > $null; $?   # True
docker manifest inspect ghcr.io/zhurykmaks11/booking-hotel-api:1.4.0 > $null; $?   # True
```

### A2. Встановити плагін `kubectl argo rollouts` (п. 1b)

Браузером: https://github.com/argoproj/argo-rollouts/releases/tag/v1.10.1 → **Assets** → `kubectl-argo-rollouts-windows-amd64` → покласти в `C:\Users\Користувач\bin` і перейменувати в `kubectl-argo-rollouts.exe` (увімкнути показ розширень у Провіднику, щоб не вийшло `.exe.txt`).

Або PowerShell:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing https://github.com/argoproj/argo-rollouts/releases/download/v1.10.1/kubectl-argo-rollouts-windows-amd64 -OutFile "$env:USERPROFILE\bin\kubectl-argo-rollouts.exe"
Unblock-File "$env:USERPROFILE\bin\kubectl-argo-rollouts.exe"
```

Перевірка в **новому** вікні PowerShell:

```powershell
kubectl argo rollouts version          # kubectl-argo-rollouts: v1.10.1
```

### A3. Довести до кінця реліз 1.2.0, який уже в `main`

PR #18 (тег `1.2.0`) змерджено до публікації образу, тому под `1.2.0` міг лишитися в `ImagePullBackOff`. Stable `1.1.0` при цьому працює (4 поди).

```powershell
kubectl -n booking-hotel-gitops get pods -L app.kubernetes.io/version
# якщо под 1.2.0 у ImagePullBackOff, а образ уже опубліковано (A1) — перезапустити його:
kubectl -n booking-hotel-gitops delete pod -l app.kubernetes.io/version=1.2.0

kubectl argo rollouts get rollout booking-hotel-api -n booking-hotel-gitops --watch
# дочекатися: Status ॥ Paused, Step 1/6, SetWeight 25 (1 под 1.2.0 : 3 поди 1.1.0)
kubectl argo rollouts promote booking-hotel-api -n booking-hotel-gitops
# ~1 хв: 50 % → 30 с → 75 % → 30 с → 100 %; Status ✔ Healthy, 4 поди 1.2.0
```

Це заодно генеральна репетиція кроків 4–5 захисту.

### A4. Пароль Argo CD

Перевірити, що пароль `admin` відомий (його змінювали в Лаб. №5). Якщо забули:

```powershell
kubectl -n argocd patch secret argocd-secret -p '{\"data\": {\"admin.password\": null, \"admin.passwordMtime\": null}}'
kubectl -n argocd rollout restart deployment argocd-server
argocd admin initial-password -n argocd
```

---

## Частина B. Перед захистом (за 10–15 хв)

### B1. Запустити кластер

```powershell
# Docker Desktop (якщо не запущено)
Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
docker info --format '{{.ServerVersion}}'       # повторювати, доки не відповість

minikube start
kubectl -n argocd get pods                       # усі 1/1 Running (1–2 хв після старту)
kubectl -n argo-rollouts get pods                # argo-rollouts і argo-rollouts-dashboard: Running
```

### B2. Відкрити термінали

| Термінал | Команда | Навіщо |
|---|---|---|
| **T1** | `kubectl -n argocd port-forward svc/argocd-server 8080:443` | інтерфейс Argo CD: https://localhost:8080 (сертифікат самопідписаний → «Додатково → Перейти»), вхід `admin` |
| **T2** | `argocd login localhost:8080 --username admin --insecure` | далі тут команди `argocd`, `kubectl argo rollouts promote/abort` |
| **T3** | `kubectl argo rollouts get rollout booking-hotel-api -n booking-hotel-gitops --watch` | стан Rollout наживо: крок, вага, ReplicaSet-и, поди |
| **T4** | цикл запитів у кластері (нижче) | відповіді обох версій |
| T5 (необов'язково) | `kubectl argo rollouts dashboard` → http://localhost:3100 | веб-дашборд Rollouts |

**T4** — под усередині кластера, який кожні 0,5 с звертається до Service `booking-hotel-api`:

```powershell
kubectl -n booking-hotel-gitops run traffic --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- `
  sh -c 'while true; do curl -s -m 2 http://booking-hotel-api/version; echo; sleep 0.5; done'
```

Зупинка — `Ctrl+C`. Якщо пише `pods "traffic" already exists`: `kubectl -n booking-hotel-gitops delete pod traffic`.

### B3. Перевірити вихідний стан

```powershell
argocd app list
# argo-rollouts   Synced  Healthy
# booking-hotel   Synced  Healthy
# root            Synced  Healthy
kubectl -n booking-hotel-gitops get rollout booking-hotel-api      # DESIRED 4, AVAILABLE 4
```

У T3 — `Status: ✔ Healthy`, один ReplicaSet `stable` з 4 подами `1.2.0`; у T4 — лише `"version":"1.2.0"`.

В інтерфейсі Argo CD відкрити `booking-hotel` у вигляді дерева: Rollout `booking-hotel-api` → ReplicaSet → 4 поди.

---

## Частина C. Демонстрація

### Крок 1. Контролер встановлено з Git (п. 1)

- Argo CD UI: `root` → дочірні `argo-rollouts` і `booking-hotel`.
- Відкрити `argocd-apps/argo-rollouts.yaml` на GitHub або в IDE.

**Казати:** «Контролер Argo Rollouts — окремий Application в `argocd-apps/`, як і застосунок. Джерело — офіційний Helm-чарт `argo-rollouts` версії 2.43.8 з репозиторію argo-helm. Root (App of Apps) підхопив файл після мерджу, нічого вручну не встановлювалось. Sync-wave `-1` — контролер і CRD синхронізуються раніше за застосунок. `ServerSideApply` — бо CRD Rollout завеликий для звичайного apply. Плагін `kubectl argo rollouts` встановлено локально».

```powershell
kubectl argo rollouts version
```

### Крок 2. Rollout у чарті й стратегія (пп. 2–3)

Показати файли:

- `helm/booking-hotel/templates/api-rollout.yaml` — Rollout, рендериться при `api.rollout.enabled: true`; той самий шаблон пода, що в Deployment (`_api-pod.tpl`); перевірка `replicaCount >= 4`.
- `helm/booking-hotel/templates/api-deployment.yaml` — `{{- if not .Values.api.rollout.enabled }}`: рендериться або Deployment, або Rollout.
- `helm/booking-hotel/values.yaml` → `api.rollout.strategy` — кроки canary.
- `helm/booking-hotel/values-minikube.yaml` — `replicaCount: 4`, `rollout.enabled: true`, `tag`.

**Казати про кроки:** «25 % → ручна пауза `pause: {}` → 50 % → пауза 30 с → 75 % → пауза 30 с → 100 %. Traffic router немає, тому вага = частка подів: при 4 репліках 25 % — це 1 под нової версії і 3 старої. `maxSurge: 1`, `maxUnavailable: 0` — спершу піднімається новий под, потім гаситься старий, 4 поди Ready завжди».

**Казати, чому canary (п. 3):**
1. Обидві версії працюють з однією БД і Redis — blue-green не дає ізоляції даних, а міграції все одно застосовуються до перемикання.
2. Помилка нової версії зачіпає лише ~25 % запитів на ручній паузі, а не 100 % після перемикання; `abort` повертає все за секунди.
3. Blue-green потребує дві повні копії (8 подів API) — для minikube забагато; canary — максимум 5.
4. API stateless, будь-який под обслуговує будь-який запит, тож розподіл за кількістю подів коректний без Ingress / mesh.

### Крок 3. Реліз 1.3.0 комітом (п. 4)

Найшвидше — прямо в браузері на GitHub:

1. Відкрити `helm/booking-hotel/values-minikube.yaml` → ✏️ (Edit).
2. `tag: "1.2.0"` → `tag: "1.3.0"`.
3. **Commit changes…** → повідомлення `release(gitops): booking-hotel api 1.3.0 (canary)` → **Create a new branch … and start a pull request** → **Propose changes** → **Create pull request**.
4. Дочекатися зелених перевірок CI (~1–2 хв; образ не збирається, бо змінено лише `helm/`) → **Merge pull request**.

Або з терміналу:

```powershell
git switch -c release-1.3.0 refs/remotes/main/main
# values-minikube.yaml: tag: "1.2.0" -> "1.3.0"
git commit -am "release(gitops): booking-hotel api 1.3.0 (canary)"
git push -u main release-1.3.0
# PR на GitHub -> Merge
```

Одразу після мерджу, щоб не чекати опитування Git (до 3 хв):

```powershell
argocd app get booking-hotel --refresh
```

**Показати:** в Argo CD `OutOfSync` → синхронізація → `Synced`; у дереві з'являється другий ReplicaSet.

### Крок 4. Проміжний стан (п. 4a)

Через ~30–60 с Rollout зупиняється на ручній паузі.

- **T3 (CLI):** `Status: ॥ Paused`, `Message: CanaryPauseStep`, `Step: 1/6`, `SetWeight: 25`, `ActualWeight: 25`; `Images`: `1.2.0 (stable)` і `1.3.0 (canary)`; ReplicaSet canary — 1 под, stable — 3 поди.
- **T4 (цикл запитів):** відповіді `"version":"1.2.0"` і `"version":"1.3.0"` упереміш, приблизно кожна четверта — `1.3.0`; `instanceId` показує, який под відповів.
- **Точне співвідношення** на 200 запитах (у T2):

  ```powershell
  kubectl -n booking-hotel-gitops run ratio --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- `
    sh -c 'for i in $(seq 200); do curl -s -m 2 http://booking-hotel-api/version | cut -d, -f1; done | sort | uniq -c'
  #  ~150 {"version":"1.2.0"
  #   ~50 {"version":"1.3.0"
  ```

- **Argo CD UI:** `booking-hotel` — **Synced / Suspended** (Suspended = Rollout на паузі, не помилка); у дереві 2 ReplicaSet-и: 1 под `1.3.0`, 3 поди `1.2.0`.
- Поди з версіями:

  ```powershell
  kubectl -n booking-hotel-gitops get pods -L app.kubernetes.io/version
  ```

### Крок 5. Promote (п. 4a)

```powershell
kubectl argo rollouts promote booking-hotel-api -n booking-hotel-gitops
```

Або в Argo CD UI: Rollout `booking-hotel-api` → ⋮ → **Resume**.

**Показати (T3, T4):** `setWeight 50` (2 : 2) → 30 с → `setWeight 75` (3 : 1) → 30 с → 100 %. У циклі запитів частка `1.3.0` росте до 100 %. Старий ReplicaSet масштабується до 0. Argo CD: `Suspended` → `Progressing` → **Synced / Healthy**.

**Казати:** «`promote` знімає паузу в статусі Rollout-а, `spec` не змінюється — тому Argo CD не бачить розбіжності з Git і `selfHeal` нічого не повертає».

### Крок 6. Реліз 1.4.0 і abort (п. 5)

Так само, як крок 3: `tag: "1.3.0"` → `tag: "1.4.0"`, PR → Merge → `argocd app get booking-hotel --refresh`.

Дочекатися ручної паузи (T3: `Paused`, Step 1/6, 1 под `1.4.0` : 3 поди `1.3.0`; T4 — обидві версії). Потім:

```powershell
kubectl argo rollouts abort booking-hotel-api -n booking-hotel-gitops
```

Або в Argo CD UI: Rollout → ⋮ → **Abort**.

**Показати:**
- T3: canary-ReplicaSet `1.4.0` → 0 подів, stable `1.3.0` → 4 поди; `Status: ✖ Degraded`, `Message: RolloutAborted: ...`;
- T4 і `ratio`: лише `"version":"1.3.0"`;
- Argo CD: **Synced / Degraded**.

**Казати, чому Synced / Degraded (головне питання п. 5):**
- **Synced** — Argo CD порівнює маніфести. У Git `tag: "1.4.0"`, у `spec` Rollout-а в кластері теж `1.4.0`: `abort` змінив лише статус Rollout-а і масштаб ReplicaSet-ів, а не `spec`. Розбіжності з Git немає.
- **Degraded** — здоров'я Argo CD бере зі статусу Rollout-а. Бажаний стан (`1.4.0` на всіх подах) не досягнуто, і контролер відмовився його досягати — реліз скасовано. При цьому застосунок повністю працює на `1.3.0`.
- Тобто кластер працює на старій версії, а Git досі «хоче» нову. Цю суперечність треба закрити в Git — відкатом.

### Крок 7. Відкат через Git (п. 5)

На GitHub відкрити змерджений PR релізу `1.4.0` → кнопка **Revert** (внизу сторінки PR) → **Create pull request** → дочекатися CI → **Merge pull request**.

Або з терміналу:

```powershell
git fetch main
git switch -c revert-1.4.0 refs/remotes/main/main
git revert -m 1 --no-edit <merge-коміт PR 1.4.0>     # хеш: git log --oneline -5 refs/remotes/main/main
git push -u main revert-1.4.0
# PR -> Merge
```

Після мерджу:

```powershell
argocd app get booking-hotel --refresh
argocd app history booking-hotel          # кожна синхронізація прив'язана до коміту
```

**Показати:** `spec` знову `1.3.0` = поточний stable-ReplicaSet → Rollout одразу **✔ Healthy** без кроків canary і без перезапуску подів. Argo CD: **Synced / Healthy**. T4: лише `1.3.0`.

**Казати:** «Відкат комітом, а не `kubectl argo rollouts undo`: `undo` змінив би `spec` у кластері, Argo CD побачив би розбіжність із Git, і `selfHeal` повернув би `1.4.0` — реліз почався б знову. `argocd app rollback` не працює з автосинхронізацією. `git revert` лишає в історії, хто, коли й чому скасував реліз».

---

## Частина D. Якщо щось пішло не так

| Ситуація | Що зробити |
|---|---|
| Після мерджу Rollout не стартує | `argocd app get booking-hotel --refresh`; в UI — **Refresh** |
| Новий под у `ImagePullBackOff` | образу з таким тегом немає в GHCR → `abort`, відкат через Git; перевірити `docker manifest inspect ...:<тег>` |
| `kubectl argo rollouts`: `unknown command "argo"` | плагін не в PATH → нове вікно PowerShell; або `promote`/`abort` через Argo CD UI (⋮ → Resume / Abort) чи `argocd app actions run booking-hotel resume --kind Rollout --resource-name booking-hotel-api` |
| `argocd`: `Unauthenticated` / `connection refused` | у T1 впав port-forward → перезапустити T1, повторити `argocd login` (T2) |
| CI на PR довго йде | на захисті показати кроки, поки CI біжить; або власник репозиторію вмикає bypass правила для `main` і пушить напряму |
| Rollout відразу 100 % без пауз | тег у PR збігається зі stable (наприклад, повернення на ту саму версію) — це очікувано; для демонстрації потрібен тег, відмінний від поточного stable |
| Треба повторити демонстрацію | будь-який опублікований тег, відмінний від поточного stable: `1.0.0` … `1.4.0` |

## Частина E. Короткі відповіді на можливі питання

- **Progressive delivery** — реліз, що виходить поступово, з паузами й перевірками, і який можна зупинити або скасувати на проміжному кроці. `RollingUpdate` так не вміє.
- **Canary vs blue-green.** Canary — частка трафіку на нову версію росте кроками. Blue-green — дві повні копії, перемикання 100 % трафіку одразу, preview-сервіс для перевірки до перемикання.
- **`pause: {}` vs `pause: {duration: 30s}`** — перша чекає `promote` безстроково, друга продовжує сама.
- **`promote` / `abort` / `retry`** — зняти паузу / повернути все на stable і позначити реліз скасованим / почати скасований реліз заново.
- **Як Argo CD знає стан Rollout-а** — вбудована health-перевірка для `argoproj.io/Rollout`: пауза → Suspended, в процесі → Progressing, скасовано → Degraded, завершено → Healthy.
- **PruneLast** — при переході Deployment → Rollout старий Deployment видалявся наприкінці синхронізації, коли поди Rollout уже Ready, — без простою.
- **Міграції БД при canary** — перший canary-под застосовує міграції до спільної БД, і stable-версія працює з новою схемою. Тому міграції мають бути зворотно сумісними (expand/contract); `abort` схему не відкочує.
