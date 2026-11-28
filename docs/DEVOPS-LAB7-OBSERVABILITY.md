# DevOps, Лаб. №7: Observability — метрики, логи, дашборди й відкат за метриками

## 1. Мета

Бачити, що відбувається із застосунком у кластері, і довірити рішення про реліз метрикам:

- **метрики** (Prometheus) — скільки запитів, яка частка помилок, яка затримка;
- **логи** (Loki + Alloy) — що саме сталося в конкретному поді;
- **дашборд** (Grafana) — усе на одному екрані, і він теж зберігається в Git;
- **автоматичний відкат** — Argo Rollouts сам перериває canary-реліз, якщо нова версія дає > 5 % помилок.

Усе встановлюється через Argo CD з Git, як і застосунок у Лаб. №5–6.

## 2. Що зроблено

| П. | Завдання | Як зроблено |
|---|---|---|
| 1 | Стек моніторингу через Argo CD | `argocd-apps/kps.yaml`, `loki.yaml`, `alloy.yaml` — по Application на чарт, версії зафіксовано: kube-prometheus-stack **94.2.0**, loki **21.6.4** (grafana-community), alloy **1.16.0**. Пароль Grafana — Secret `grafana-admin`, створений вручну |
| 2 | Метрики застосунку | NestJS + `prom-client`: `GET /metrics`, `http_requests_total{method,route,status}`, `http_request_duration_seconds{route}` (гістограма). `route` — шаблон (`/hotels/:id`), не URL. ServiceMonitor у чарті |
| 3 | Логи | JSON у stdout, один об'єкт на рядок: системні логи Nest і рядок на кожен запит (`level`, `route`, `status`, `duration_ms`, `version`). Alloy відправляє їх у Loki з мітками `namespace`, `pod`, `app`, `component` |
| 4 | Дашборд | `helm/booking-hotel/dashboards/booking-hotel.json` → ConfigMap з міткою `grafana_dashboard: "1"`; sidecar Grafana підхоплює його сам |
| 5 | Навантаження | `hey` (короткий тест) і Deployment `load` з curl (фоновий трафік) — команди нижче |
| 6 | Відкат за метриками | AnalysisTemplate (частка не-5xx ≥ 95 %), крок `analysis` у canary замість ручної паузи; `FAIL_RATE` у застосунку імітує погану версію. Алерт PrometheusRule (п. d) |

**Стратегія — canary** (варіант a, як у Лаб. №6), 5 реплік:

```
setWeight 20 (1 под нової версії : 4 stable) → пауза 30 с → АНАЛІЗ → setWeight 60 → пауза 30 с → 100 %
```

Аналіз: запит до Prometheus кожні 30 с, 4 виміри, допускається 1 провал. Под із `FAIL_RATE=0.5` — це 1 з 5 подів, тож помилок по сервісу ≈ 10 % > 5 % → **AnalysisRun Failed → abort**, усі поди знову stable.

## 3. Файли

| Файл | Що в ньому |
|---|---|
| `argocd-apps/kps.yaml`, `loki.yaml`, `alloy.yaml` | стек моніторингу (п. 1) |
| `src/observability/metrics.service.ts` | лічильник і гістограма, `collectDefaultMetrics` (CPU, пам'ять, event loop Node.js) |
| `src/observability/http-observability.middleware.ts` | метрики й JSON-лог кожного запиту (на `finish`, тож статус і маршрут уже відомі) |
| `src/observability/failure-injection.interceptor.ts` | `FAIL_RATE`: 500 на частку запитів; `/health` і `/metrics` не зачіпаються, под лишається Ready |
| `src/observability/json-logger.ts` | логер Nest у JSON (`LOG_FORMAT=json`, за замовчуванням у production) |
| `helm/booking-hotel/templates/servicemonitor.yaml` | скрейп `/metrics` кожні 15 с; `podTargetLabels` додає до метрик версію і hash ReplicaSet |
| `templates/analysistemplate.yaml` | критерій успіху релізу |
| `templates/prometheusrule.yaml` | алерт `BookingHotelHighErrorRate`: 5xx > 5 % протягом 1 хв |
| `templates/dashboard.yaml` + `dashboards/booking-hotel.json` | дашборд із Git |
| `values-minikube.yaml` | 5 реплік, кроки canary з аналізом, `FAIL_RATE`, `metrics.enabled` |
| `Dockerfile` | `apk upgrade`: без нього CI не публікував образ (Critical CVE-2026-4738 у zlib) |

## 4. Розгортання (один раз)

**4.1. Образи.** Код Лаб. №7 потрапляє в образ лише з git-тегу. Три версії для демонстрації (код однаковий, різні теги) — на коміт PR Лаб. №7 **до** мерджу:

```powershell
git fetch main
git tag -a v1.5.0 main/devops-lab7-observability -m "Release 1.5.0"
git tag -a v1.6.0 main/devops-lab7-observability -m "Release 1.6.0"
git tag -a v1.7.0 main/devops-lab7-observability -m "Release 1.7.0"
git push main v1.5.0 v1.6.0 v1.7.0
docker manifest inspect ghcr.io/zhurykmaks11/booking-hotel-api:1.7.0 > $null; $?   # True, коли CI зелений
```

Потім змерджити PR. Порядок PR: `fix-docker-zlib` → `devops-lab7-monitoring` (стек, окремий коміт) → `devops-lab7-observability`.

**4.2. Кластер на 4 CPU / 8 ГБ** (стек важкий; у Docker Desktop → Settings → Resources має бути ≥ 10 ГБ пам'яті):

```powershell
minikube delete
minikube start --cpus 4 --memory 8192
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Secret-и не з Git
kubectl create namespace booking-hotel-gitops
kubectl -n booking-hotel-gitops create secret generic booking-hotel-db-secret --from-literal=POSTGRES_PASSWORD=<пароль> --from-literal=DATABASE_URL="postgresql://postgres:<пароль>@booking-hotel-postgres:5432/hotel_booking?schema=public"
kubectl create namespace monitoring
kubectl -n monitoring create secret generic grafana-admin --from-literal=admin-user=admin --from-literal=admin-password=<пароль>

kubectl apply -f bootstrap/root.yaml
```

Через 3–7 хв:

```powershell
kubectl -n argocd port-forward svc/argocd-server 8080:443          # окреме вікно
argocd admin initial-password -n argocd
argocd login localhost:8080 --username admin --insecure
argocd app list     # root, argo-rollouts, kps, loki, alloy, booking-hotel: Synced / Healthy
```

`booking-hotel` при першій синхронізації може кілька разів повторити спробу (`retry`): ServiceMonitor чекає, поки kps встановить свій CRD.

**4.3. Доступ:**

```powershell
kubectl -n monitoring port-forward svc/kps-grafana 3000:80          # http://localhost:3000, admin / пароль з 4.2
kubectl -n monitoring port-forward svc/kps-prometheus 9090:9090     # http://localhost:9090
kubectl -n monitoring port-forward svc/kps-alertmanager 9093:9093   # необов'язково
```

## 5. Запити

**PromQL** (Prometheus → Graph або Grafana → Explore):

```promql
# запити за секундою за статусом
sum by (status) (rate(http_requests_total{namespace="booking-hotel-gitops"}[1m]))
# частка 5xx
sum(rate(http_requests_total{namespace="booking-hotel-gitops",status=~"5.."}[1m]))
  / sum(rate(http_requests_total{namespace="booking-hotel-gitops"}[1m]))
# p95 затримки
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{namespace="booking-hotel-gitops"}[1m])))
# трафік за версією (під час canary)
sum by (app_kubernetes_io_version) (rate(http_requests_total{namespace="booking-hotel-gitops"}[1m]))
# 5xx по подах
sum by (pod) (rate(http_requests_total{namespace="booking-hotel-gitops",status=~"5.."}[1m]))
```

**LogQL** (Grafana → Explore → Loki):

```logql
{namespace="booking-hotel-gitops", component="api"}
{namespace="booking-hotel-gitops", component="api"} | json | status >= 500
{namespace="booking-hotel-gitops", component="api"} | json | duration_ms > 200 | line_format "{{.route}} {{.duration_ms}}ms"
sum by (pod) (count_over_time({namespace="booking-hotel-gitops", component="api"} | json | status >= 500 [1m]))
```

## 6. Навантаження

```powershell
# короткий тест: 20 клієнтів 3 хв
kubectl run hey --rm -it --restart=Never --image=williamyeh/hey -- -z 3m -c 20 http://booking-hotel-api.booking-hotel-gitops.svc/hotels
# те саме з затримкою 200 мс на запит -> росте p95
kubectl run hey --rm -it --restart=Never --image=williamyeh/hey -- -z 2m -c 20 -H "X-Synthetic-Delay: 200" http://booking-hotel-api.booking-hotel-gitops.svc/hotels

# фоновий трафік — ОБОВ'ЯЗКОВО під час релізу: без запитів аналіз отримує 0/0 = NaN і провалюється
kubectl create deployment load --image=curlimages/curl -- sh -c 'while true; do curl -s -o /dev/null http://booking-hotel-api.booking-hotel-gitops.svc/hotels; sleep 0.05; done'
kubectl scale deployment load --replicas=3     # більше трафіку
kubectl delete deployment load                 # зупинити
```

## 7. Демонстрація на захисті

Заздалегідь: усі Application **Healthy**, фоновий `load` запущено, відкриті Grafana (дашборд **Booking Hotel API**, «Last 15 minutes», автооновлення 10s), Prometheus, і в терміналі:

```powershell
kubectl argo rollouts get rollout booking-hotel-api -n booking-hotel-gitops --watch
```

1. **Метрики.** Prometheus → Status → Targets: `serviceMonitor/booking-hotel-gitops/booking-hotel-api/0` — 5/5 UP. У Graph — запит з п. 5.
2. **Навантаження.** Запустити `hey` → на дашборді росте RPS, CPU подів; з `X-Synthetic-Delay: 200` — p95.
3. **Логи.** Grafana → Explore → Loki: `{namespace="booking-hotel-gitops", component="api"} | json | status >= 500` (поки що порожньо).
4. **Дашборд із Git.** Показати `dashboards/booking-hotel.json` і ConfigMap. Видалити ConfigMap — Argo CD (selfHeal) поверне його, дашборд з'явиться знову:
   ```powershell
   kubectl -n booking-hotel-gitops delete configmap booking-hotel-dashboard
   ```
5. **Хороший реліз.** У `values-minikube.yaml` `tag: "1.5.0"` → `"1.6.0"`, PR → Merge → `argocd app get booking-hotel --refresh`. Rollout: 20 % → пауза → **AnalysisRun Successful** → 60 % → 100 %.
   ```powershell
   kubectl -n booking-hotel-gitops get analysisrun
   ```
6. **Поганий реліз.** Одним комітом `tag: "1.7.0"` і `FAIL_RATE: "0.5"`, PR → Merge → refresh. Що видно:
   - `--watch`: 20 % (1 под 1.7.0) → пауза → аналіз → **AnalysisRun Failed** → `✖ Degraded`, усі 5 подів знову 1.6.0;
   - Argo CD: **Synced / Degraded**;
   - дашборд: «Частка 5xx» ≈ 10 % і повертається до 0, «5xx по подах» — лише один под, «Запити за версією» — 1.7.0 зникає;
   - Loki `| json | status >= 500` — рядки лише з пода нової версії (`"version":"1.7.0"`);
   - причина провалу з виміряними значеннями:
     ```powershell
     kubectl -n booking-hotel-gitops describe analysisrun <ім'я з get analysisrun>
     ```
7. **Відкат через Git.** На змердженому PR поганого релізу → **Revert** → PR → Merge → refresh. `spec` знову 1.6.0 = stable → Rollout одразу **Healthy**, Argo CD **Synced / Healthy**.

**Алерт (п. d).** Prometheus → Alerts: `BookingHotelHighErrorRate`. Через `for: 1m` і швидкий abort він зазвичай встигає лише в Pending. Щоб показати Firing: тимчасово `api.rollout.analysis.enabled: false` і випустити `FAIL_RATE: "0.5"` повністю — через ~1–2 хв алерт Firing (видно й в Alertmanager), потім revert.

## 8. Типові проблеми

| Симптом | Причина / що робити |
|---|---|
| Поди моніторингу `Pending` | бракує пам'яті minikube: `kubectl describe pod`, кластер на 8 ГБ |
| `booking-hotel`: `no matches for kind ServiceMonitor` | kps ще не встановив CRD — Argo CD повторить синхронізацію сам (`retry`); або Refresh / Sync |
| Ціль не в Targets | ServiceMonitor не знайшов Service: мітки або ім'я порту `http` |
| AnalysisRun завжди `Failed` / `Error` | немає трафіку (NaN) — запустіть `load`; перевірте запит аналізу вручну в Prometheus |
| Поди API `ImagePullBackOff` | образу з тегом немає: CI з тегу не пройшов (`docker manifest inspect ...`) |
| Дашборда немає в Grafana | ConfigMap без мітки `grafana_dashboard: "1"` або зламаний JSON — `kubectl -n monitoring logs deploy/kps-grafana -c grafana-sc-dashboard` |
| У Loki рядки без полів | це вивід міграцій Prisma з `entrypoint.sh` до старту API — не JSON, `| json` їх пропускає |

## 9. Питання на захисті

- **Метрики vs логи.** Метрики — числа з мітками, дешево зберігати й агрегувати, показують *що* і *скільки* (частка 5xx зросла). Логи — окремі події з деталями, показують *чому* (який маршрут, який под, яка помилка).
- **Чому route — шаблон, а не URL?** Кожна унікальна комбінація міток — окремий часовий ряд. `/hotels/<uuid>` створював би ряд на кожен готель (висока кардинальність) — Prometheus роздувається.
- **Counter vs Histogram.** Counter лише росте, з нього `rate()` дає RPS. Histogram рахує запити по кошиках тривалості (`le`), з них `histogram_quantile` оцінює p95 по всіх подах.
- **Чому `rate(...[1m])`, а не саме значення лічильника?** Лічильник накопичувальний і обнуляється при рестарті пода; `rate` дає швидкість і коректно обробляє скидання.
- **Як Prometheus знаходить застосунок?** Prometheus Operator читає ServiceMonitor → знаходить Service за мітками → скрейпить `/metrics` кожного пода за Endpoints, додаючи мітки `namespace`, `pod`, `service`.
- **Чому аналіз потребує трафіку?** Запит — частка: успішні / усі. Без запитів 0/0 = NaN, умова `>= 0.95` не виконується → Failed навіть для хорошої версії.
- **Чому аналіз по всьому сервісу ловить погану версію?** Без traffic router 20 % подів = 20 % трафіку; 50 % помилок на одному поді з п'яти ≈ 10 % по сервісу > 5 %. Точніше — фільтрувати лише canary за `rollouts_pod_template_hash` (мітка вже є в метриках через `podTargetLabels`).
- **Чому після провалу аналізу Synced / Degraded, а не OutOfSync?** Як і з ручним abort у Лаб. №6: Argo Rollouts змінив лише статус і ReplicaSet-и, а не `spec`, тож розбіжності з Git немає; Degraded — бажаний стан з Git не досягнуто. Закривається `git revert`.
- **Чому пароль Grafana не в Git і не в values?** Секрет у Git — витік; а згенерований чартом пароль змінювався б на кожному рендерингу Argo CD.
- **Навіщо `ServerSideApply` для kps?** CRD Prometheus / Alertmanager завеликі для анотації `last-applied-configuration` (> 256 KB).
