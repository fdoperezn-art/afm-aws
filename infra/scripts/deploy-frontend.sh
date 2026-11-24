#!/usr/bin/env bash
# Compila el frontend con los valores de la pila y lo publica en Amplify Hosting (despliegue manual).
# Uso: ./deploy-frontend.sh   (lee las salidas de la pila AfmStack desde CloudFormation)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/infra/outputs.json"
REGION="${AWS_REGION:-us-east-2}"
# Siempre usa las salidas actuales de la pila (outputs.json no se versiona).
aws cloudformation describe-stacks --stack-name AfmStack --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json \
  | node -e "const o=JSON.parse(require('fs').readFileSync(0));const r={};for(const x of o)r[x.OutputKey]=x.OutputValue;console.log(JSON.stringify({AfmStack:r},null,2))" > "$OUT"
out() { node -e "console.log(require('$OUT').AfmStack['$1'])"; }

APP_ID="$(out AmplifyAppId)"
BRANCH="$(out AmplifyBranch)"

cat > "$ROOT/frontend/.env.production" <<ENV
VITE_API_URL=$(out ApiUrl)
VITE_USER_POOL_ID=$(out UserPoolId)
VITE_USER_POOL_CLIENT_ID=$(out UserPoolClientId)
ENV

echo "▶ Compilando frontend…"
(cd "$ROOT/frontend" && npm ci --silent && npm run build --silent)

ZIP="$(mktemp -d)/site.zip"
(cd "$ROOT/frontend/dist" && zip -qr "$ZIP" .)

echo "▶ Creando despliegue en Amplify ($APP_ID/$BRANCH)…"
read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
  --region "$REGION" --query '[jobId, zipUploadUrl]' --output text)
curl -sSf -X PUT -H 'Content-Type: application/zip' --upload-file "$ZIP" "$UPLOAD_URL" >/dev/null
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --region "$REGION" >/dev/null

echo "▶ Esperando a que termine (job $JOB_ID)…"
for _ in $(seq 1 60); do
  STATUS="$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" \
    --region "$REGION" --query 'job.summary.status' --output text)"
  case "$STATUS" in
    SUCCEED) echo "✅ Publicado en $(out SiteUrl)"; exit 0 ;;
    FAILED|CANCELLED) echo "❌ Despliegue $STATUS"; exit 1 ;;
  esac
  sleep 5
done
echo "⏱ El despliegue sigue en curso; revisa la consola de Amplify."; exit 1
