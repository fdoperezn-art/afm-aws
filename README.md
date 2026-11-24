# AFM · Aquí falta la muni — en AWS

Mapa ciudadano de Conchalí (antes un piloto en Netlify que guardaba todo en el navegador),
ahora con backend real en AWS, Región **us-east-2**.

```
Vecinos ──► Amplify Hosting (Vite: mapa + asistente)       Moderadores ──► /admin/ (Cognito + MFA)
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
| Datos | DynamoDB (on-demand, PITR, protección contra borrado) | Reportes y avisos de contenido |
| Fotos | S3 privado, cifrado, solo HTTPS | `uploads/` expira en 24 h; las fotos válidas pasan a `reports/<id>/` |
| Acceso | Cognito User Pool `afm-moderadores`, grupo `moderadores` | Sin registro abierto, MFA TOTP obligatorio |

## Rutas de la API

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/reports` | Pública (sin datos de contacto) |
| POST | `/uploads` | Pública: devuelve URL firmada para subir 1 foto (≤ 5 MB, JPG/PNG/WebP) |
| POST | `/reports` | Pública: crea el reporte; devuelve un `deleteToken` |
| DELETE | `/reports/{id}` | Quien lo creó (cabecera `X-Delete-Token`) |
| POST | `/reports/{id}/flags` | Pública: aviso de contenido |
| GET | `/admin/reports` · `/admin/flags` | Moderadores (incluye datos de contacto) |
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

## Crear un moderador

Cognito le envía un correo con una contraseña temporal. En el primer ingreso a `/admin/`
deberá crear su contraseña y activar la verificación en dos pasos (app de autenticación).

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
