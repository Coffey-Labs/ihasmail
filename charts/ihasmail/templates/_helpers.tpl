{{- define "ihasmail.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "ihasmail.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ihasmail.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ihasmail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ihasmail.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ihasmail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
