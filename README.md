# AFM · Aquí falta la muni — en AWS

Mapa ciudadano de Conchalí (antes un piloto en Netlify que guardaba todo en el navegador),
ahora con backend real en AWS, Región **us-east-2**.

```
Vecinos ──► Amplify Hosting (Vite: mapa + asistente)       Moderadores ──► /admin/ (Cognito)    
                │                                                              │ token JWT
                ▼                                                              ▼
           API Gateway (REST, throttling) ──────────────► Lambda (Node.js 24, ARM)
                                                             │            │
                                         DynamoDB (tabla única) ◄┘            └► S3 privado (fotos)
                                                                         ▲
                       navegador ── subida directa con URL firmada ──────┘
```

| Pieza | Recurso | Notas |
|---|---|---|
| Frontend | Amplify Hosting (despliegue manual de `frontend/dist`) | Cabeceras de seguridad (CSP, HSTS, X-Frame-Options) |
| API | API Gateway REST `afm-api`, etapa `prod` | Límites anti-spam en las rutas públicas que escriben |
| Lógica | Lambda `ApiFunction` (`infra/lambda/api/index.mjs`) | Valida con las mismas reglas que el navegador (`shared/`) |
| Datos | DynamoDB (on-demand, PITR, protección contra borrado) | Reportes, tickets y avisos de contenido |
| Fotos | S3 privado, cifrado, solo HTTPS | `uploads/` expira en 24 h; las fotos válidas pasan a `reports/<id>/` |
| Acceso | Cognito User Pool `afm-moderadores`, grupo `moderadores` | Sin registro abierto, ingreso con correo y contraseña (MFA desactivado) |

## Tickets y duplicados

Cada reporte de un vecino se guarda completo (con sus datos de contacto) y queda asignado a un **ticket**
interno (`T-0001`, `T-0002`, …). Un ticket es un caso: en el mapa público se ve un solo punto con
«N vecinos lo reportaron». El número de ticket solo lo ve el equipo de moderación.

| Situación | Qué pasa |
|---|---|
| Misma foto exacta (huella SHA-256 igual) | Se une automáticamente al ticket existente |
| Misma foto reenviada/recomprimida (huella perceptual dHash a ≤ 8 bits) y a ≤ 500 m | Se une automáticamente |
| Foto parecida pero lejos, o misma categoría a ≤ 50 m | Queda como **posible duplicado** en el panel; decide el moderador |
| Unión equivocada | «Separar en ticket nuevo» en el panel |
| Duplicado no detectado | «Marcar como duplicado de T-XXXX» en el panel |

Las huellas se calculan en el servidor (la del teléfono no se usa) y las fotos casi uniformes (muy oscuras)
no se unen por huella perceptual. Los umbrales están en `shared/rules.js`. Al vecino no se le informa si su
reporte se unió a un caso existente.

Las fotos se reducen en el teléfono antes de subirse (JPEG de 1600 px, ~100–300 KB) y así se eliminan
sus metadatos EXIF, incluida la ubicación GPS.

## Rutas de la API

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/reports` | Pública: casos agrupados, sin datos de contacto ni número de ticket |
| POST | `/uploads` | Pública: URL firmada para subir 1 foto JPEG (≤ 3 MB) |
| POST | `/reports` | Pública: crea el reporte (y lo asigna a un ticket); devuelve un `deleteToken` |
| DELETE | `/reports/{id}` | Quien lo creó (cabecera `X-Delete-Token`) |
| POST | `/reports/{id}/flags` | Pública: aviso de contenido |
| GET | `/admin/tickets` · `/admin/flags` | Moderadores (incluye datos de contacto y sugerencias de duplicado) |
| POST | `/admin/tickets/{ticketId}/merge` | Moderadores: `{"into":"T-0042"}` |
| POST | `/admin/reports/{id}/detach` | Moderadores: saca el reporte a un ticket nuevo |
| DELETE | `/admin/reports/{id}` | Moderadores |
| PATCH | `/admin/reports/{id}/flags/{flagId}` | Moderadores (`{"status":"resolved"}`) |

## Estructura

```
shared/      Reglas comunes (categorías, límite comunal, validación) para navegador y Lambda
frontend/    Vite: index.html (mapa) y admin/index.html (moderación)
infra/       AWS CDK (TypeScript) + Lambda + scripts de despliegue
```

## Desplegar

Requisitos: Node.js 22+, AWS CLI con sesión iniciada (`aws login`) en el perfil que uses.

```bash
cd infra && npm ci
npx cdk deploy AfmStack                               # infraestructura
./scripts/deploy-frontend.sh                          # compila y publica el frontend
```

La primera vez en una cuenta/Región nueva: `npx cdk bootstrap aws://<cuenta>/us-east-2`.

## Despliegue automático (GitHub Actions)

Cada push a `main` ejecuta `.github/workflows/deploy.yml`: despliega la infraestructura y publica el sitio.
No guarda claves de AWS: usa OIDC con el rol `afm-github-deploy` (pila `AfmCiStack`), que solo acepta
pushes a `main` de `fdoperezn-art/afm-aws`. Activación (una sola vez):

```bash
cd infra && npx cdk deploy AfmCiStack        # crea el proveedor OIDC y el rol
```

Luego, en GitHub: *Settings → Secrets and variables → Actions → Variables → New repository variable*
`AWS_DEPLOY_ROLE_ARN` = el valor `DeployRoleArn` que muestra el comando anterior.
Mientras esa variable no exista, el flujo no hace nada.

## Crear un moderador

Cognito le envía un correo con una contraseña temporal. En el primer ingreso a `/admin/`
deberá crear su contraseña.

```bash
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id <UserPoolId> \
  --username persona@correo.cl --user-attributes Name=email,Value=persona@correo.cl Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id <UserPoolId> \
  --username persona@correo.cl --group-name moderadores
```

## Desarrollo local

```bash
cd frontend && npm ci
cp .env.example .env.local   # o usa los valores de infra/outputs.json
npm run dev                  # http://localhost:5173 (permitido en CORS)
```

## Costos (plan gratuito)

Con el tráfico esperado de una comuna, todo cabe en la capa gratuita o cuesta centavos:
Lambda, API Gateway, DynamoDB on-demand, S3 y Cognito (hasta 10.000 usuarios activos/mes).
Amplify Hosting cobra por GB servido y almacenado más allá de la capa gratuita.

## Eliminar todo

La pila tiene protección contra borrado, y la tabla, el bucket y el User Pool se **conservan**
al eliminarla (son datos de vecinos). Para borrar de verdad:

```bash
aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name AfmStack --region us-east-2
npx cdk destroy AfmStack
# Luego, a mano y solo si estás seguro: desactiva la protección contra borrado de la tabla y bórrala,
# vacía y borra el bucket de fotos, y borra el User Pool.
```

## Mejoras sugeridas

- **AWS WAF** con límite por IP en la API (el throttling actual es global, no por persona). Tiene costo mensual.
- **CloudFront** delante del bucket de fotos para cachearlas (hoy se sirven con URLs firmadas de 1 h).
- **Moderación previa** (estado «pendiente» antes de publicar) si aparece spam.
- **Dominio propio** (p. ej. `afmconchali.cl`) en Amplify, y luego actualizar CORS/CSP.
- **CI/CD**: conectar Amplify a un repositorio de GitHub para desplegar con cada push.
