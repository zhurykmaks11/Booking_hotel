{{/*
Шаблон пода API — спільний для Deployment (api.rollout.enabled: false) і Rollout (true).
Обидва об'єкти підставляють його в spec.template через include ... | nindent 4.
Виклик: include "booking-hotel.apiPodTemplate" .
*/}}
{{- define "booking-hotel.apiPodTemplate" -}}
metadata:
  labels:
    {{- include "booking-hotel.labels" (dict "ctx" $ "component" "api") | nindent 4 }}
  annotations:
    # Зміна ConfigMap/Secret -> нова контрольна сума -> автоматичний rolling restart подів
    checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: api
      image: {{ include "booking-hotel.apiImage" . | quote }}
      imagePullPolicy: {{ .Values.api.image.pullPolicy }}
      ports:
        - name: http
          containerPort: {{ .Values.api.containerPort }}
      envFrom:
        - configMapRef:
            name: {{ include "booking-hotel.fullname" . }}-config
        - secretRef:
            name: {{ include "booking-hotel.secretName" . }}
      resources:
        {{- toYaml .Values.api.resources | nindent 8 }}
      # Старт включає prisma migrate deploy — до 150 с
      startupProbe:
        httpGet:
          path: /health/live
          port: http
        periodSeconds: 5
        failureThreshold: 30
      livenessProbe:
        httpGet:
          path: /health/live
          port: http
        periodSeconds: 10
        timeoutSeconds: 3
        failureThreshold: 3
      readinessProbe:
        httpGet:
          path: /health
          port: http
        periodSeconds: 5
        timeoutSeconds: 3
        failureThreshold: 2
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 5"]
{{- end }}
