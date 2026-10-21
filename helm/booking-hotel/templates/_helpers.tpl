{{/*
Ім'я чарта (можна перевизначити через nameOverride).
*/}}
{{- define "booking-hotel.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Повне ім'я об'єктів — будується з імені релізу, щоб чарт можна було встановити двічі в один кластер.
Реліз "booking-hotel" -> "booking-hotel"; реліз "test" -> "test-booking-hotel".
*/}}
{{- define "booking-hotel.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Ім'я об'єкта компонента: <fullname>-<component>, напр. booking-hotel-api.
Виклик: include "booking-hotel.componentName" (dict "ctx" $ "component" "api")
*/}}
{{- define "booking-hotel.componentName" -}}
{{- printf "%s-%s" (include "booking-hotel.fullname" .ctx) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Мітка версії чарта: booking-hotel-0.1.0
*/}}
{{- define "booking-hotel.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Мітки-селектори (незмінні між оновленнями): за ними Deployment/Service знаходять поди.
Виклик: include "booking-hotel.selectorLabels" (dict "ctx" $ "component" "api")
*/}}
{{- define "booking-hotel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "booking-hotel.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Повний набір міток для всіх об'єктів (version = тег образу API, що реально розгорнутий).
Виклик: include "booking-hotel.labels" (dict "ctx" $ "component" "api")
*/}}
{{- define "booking-hotel.labels" -}}
helm.sh/chart: {{ include "booking-hotel.chart" .ctx }}
{{ include "booking-hotel.selectorLabels" . }}
app.kubernetes.io/version: {{ default .ctx.Chart.AppVersion .ctx.Values.api.image.tag | toString | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: booking-hotel
{{- end }}

{{/*
Образ API: repository:tag (tag за замовчуванням = appVersion).
*/}}
{{- define "booking-hotel.apiImage" -}}
{{- printf "%s:%s" .Values.api.image.repository (default .Chart.AppVersion .Values.api.image.tag | toString) }}
{{- end }}

{{/*
Рядок підключення до БД (потрапляє лише в Secret).
*/}}
{{- define "booking-hotel.databaseUrl" -}}
{{- printf "postgresql://%s:%s@%s:5432/%s?schema=public" .Values.postgres.user .Values.secrets.postgresPassword (include "booking-hotel.componentName" (dict "ctx" . "component" "postgres")) .Values.postgres.database }}
{{- end }}

{{/*
Мітки подів stateful/інфраструктурних компонентів (postgres, redis): лише стабільні значення.
Без version/helm.sh/chart, щоб зміна тега API або версії чарта НЕ перезапускала БД і кеш.
Виклик: include "booking-hotel.stablePodLabels" (dict "ctx" $ "component" "postgres")
*/}}
{{- define "booking-hotel.stablePodLabels" -}}
{{ include "booking-hotel.selectorLabels" . }}
app.kubernetes.io/part-of: booking-hotel
{{- end }}
