import * as path from 'node:path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Fn,
  aws_amplify as amplify,
  aws_apigateway as apigw,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const ADMIN_GROUP = 'moderadores';
const LOCAL_DEV_ORIGIN = 'http://localhost:5173';
/** Dominio propio (DNS en Cloudflare; asociado a Amplify por API, ver README). */
const CUSTOM_DOMAIN = 'afmconchali.cl';

/**
 * AFM · Aquí falta la muni — infraestructura completa:
 * Amplify Hosting (frontend) + API Gateway + Lambda + DynamoDB + S3 (fotos) + Cognito (moderadores).
 */
export class AfmStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Hosting del frontend (Amplify, despliegue manual de archivos estáticos) ----------
    const app = new amplify.CfnApp(this, 'WebApp', {
      name: 'afm-conchali',
      description: 'AFM · Aquí falta la muni — mapa ciudadano de Conchalí',
      platform: 'WEB',
      customRules: [
        // Una sola dirección oficial: www → dominio sin www.
        { source: `https://www.${CUSTOM_DOMAIN}`, target: `https://${CUSTOM_DOMAIN}`, status: '301' },
        { source: `https://www.${CUSTOM_DOMAIN}/<*>`, target: `https://${CUSTOM_DOMAIN}/<*>`, status: '301' },
        { source: '/admin', target: '/admin/', status: '301' },
        { source: '/admin/<*>', target: '/admin/index.html', status: '404-200' },
        { source: '/<*>', target: '/index.html', status: '404-200' },
      ],
    });
    const branch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: app.attrAppId,
      branchName: 'main',
      stage: 'PRODUCTION',
      enableAutoBuild: false,
    });
    const amplifyOrigin = `https://main.${app.attrDefaultDomain}`; // sigue funcionando
    const siteOrigin = `https://${CUSTOM_DOMAIN}`;
    const allowedOrigins = [siteOrigin, amplifyOrigin, LOCAL_DEV_ORIGIN];

    // ---------- Datos: DynamoDB (diseño de tabla única) ----------
    // Reporte: PK=REPORT#<id> SK=META            GSI1PK=REPORT GSI1SK=<fecha>#<id>
    // Aviso:   PK=REPORT#<id> SK=FLAG#<avisoId>   GSI1PK=FLAG   GSI1SK=<fecha>#<avisoId>
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN, // datos ciudadanos: no se borran al eliminar la pila
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---------- Fotos: S3 privado ----------
    const photos = new s3.Bucket(this, 'Photos', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { id: 'expire-unused-uploads', prefix: 'uploads/', expiration: Duration.days(1) },
        { id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    // ---------- Autenticación: Cognito (solo moderadores) ----------
    const userPool = new cognito.UserPool(this, 'Moderators', {
      userPoolName: 'afm-moderadores',
      selfSignUpEnabled: false, // las cuentas las crea un administrador
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Ingreso solo con correo y contraseña (decisión del equipo). Para reactivar la verificación
      // en dos pasos: mfa: cognito.Mfa.REQUIRED, mfaSecondFactor: { otp: true, sms: false }.
      mfa: cognito.Mfa.OFF,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Tu acceso al panel de moderación de AFM',
        emailBody: `Hola. Te dieron acceso al panel de moderación de AFM (${siteOrigin}/admin/).<br>Usuario: {username}<br>Contraseña temporal: {####}<br>Al entrar deberás crear una contraseña nueva.`,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new cognito.CfnUserPoolGroup(this, 'ModeratorsGroup', {
      userPoolId: userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'Equipo de moderación de AFM',
    });
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'afm-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
      enableTokenRevocation: true,
    });

    // ---------- Lógica: Lambda ----------
    const apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'api', 'index.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024, // más memoria = más CPU para leer las fotos y calcular sus huellas
      timeout: Duration.seconds(20),
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: photos.bucketName,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        ADMIN_GROUP,
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        minify: true,
        sourceMap: false,
        externalModules: [], // incluye el AWS SDK en el paquete (versiones fijas)
        banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
      },
    });
    table.grantReadWriteData(apiFunction);
    photos.grantReadWrite(apiFunction);
    photos.grantDelete(apiFunction);

    // ---------- API REST: API Gateway ----------
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'afm-api',
      description: 'API de AFM · Aquí falta la muni',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        methodOptions: {
          // Límites más estrictos en las rutas públicas que escriben (anti-spam).
          '/reports/POST': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
          '/uploads/POST': { throttlingRateLimit: 4, throttlingBurstLimit: 10 },
          '/reports/{id}/flags/POST': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
        },
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Delete-Token'],
        maxAge: Duration.hours(1),
      },
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      cloudWatchRole: false,
    });
    // Errores de API Gateway (p. ej. 401 del autorizador o 429 por throttling) también con CORS.
    for (const type of [apigw.ResponseType.DEFAULT_4XX, apigw.ResponseType.DEFAULT_5XX]) {
      api.addGatewayResponse(`Cors${type.responseType}`, {
        type,
        responseHeaders: { 'Access-Control-Allow-Origin': `'${siteOrigin}'`, Vary: "'Origin'" },
      });
    }

    const integration = new apigw.LambdaIntegration(apiFunction);
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'ModeratorAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'afm-moderadores',
    });
    const asModerator = { authorizer, authorizationType: apigw.AuthorizationType.COGNITO };

    // Públicas
    const reportsRes = api.root.addResource('reports');
    reportsRes.addMethod('GET', integration);
    reportsRes.addMethod('POST', integration);
    const reportRes = reportsRes.addResource('{id}');
    reportRes.addMethod('DELETE', integration);
    reportRes.addResource('flags').addMethod('POST', integration);
    api.root.addResource('uploads').addMethod('POST', integration);

    // Moderación (token de Cognito obligatorio)
    const adminRes = api.root.addResource('admin');
    const adminTickets = adminRes.addResource('tickets');
    adminTickets.addMethod('GET', integration, asModerator);
    adminTickets.addResource('{ticketId}').addResource('merge').addMethod('POST', integration, asModerator);
    const adminReport = adminRes.addResource('reports').addResource('{id}');
    adminReport.addMethod('DELETE', integration, asModerator);
    adminReport.addResource('detach').addMethod('POST', integration, asModerator);
    adminReport.addResource('flags').addResource('{flagId}').addMethod('PATCH', integration, asModerator);
    adminRes.addResource('flags').addMethod('GET', integration, asModerator);

    // ---------- Cabeceras de seguridad del sitio ----------
    const apiOrigin = `https://${api.restApiId}.execute-api.${this.region}.amazonaws.com`;
    // Patrón de dominio (no el bucket exacto) para evitar una dependencia circular sitio ↔ bucket.
    const photosOrigin = `https://*.s3.${this.region}.amazonaws.com`;
    const cognitoOrigin = `https://cognito-idp.${this.region}.amazonaws.com`;
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      `img-src 'self' data: blob: https://tile.openstreetmap.org ${photosOrigin}`,
      `connect-src 'self' ${apiOrigin} ${photosOrigin} ${cognitoOrigin} https://nominatim.openstreetmap.org`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
    app.customHeaders = Fn.join('\n', [
      'customHeaders:',
      "  - pattern: '**/*'",
      '    headers:',
      "      - key: 'Strict-Transport-Security'",
      "        value: 'max-age=31536000; includeSubDomains'",
      "      - key: 'X-Content-Type-Options'",
      "        value: 'nosniff'",
      "      - key: 'X-Frame-Options'",
      "        value: 'DENY'",
      "      - key: 'Referrer-Policy'",
      "        value: 'strict-origin-when-cross-origin'",
      "      - key: 'Permissions-Policy'",
      "        value: 'geolocation=(self), camera=(), microphone=()'",
      "      - key: 'Content-Security-Policy'",
      `        value: "${csp}"`,
    ]);

    // ---------- Salidas ----------
    new CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new CfnOutput(this, 'AdminUrl', { value: `${siteOrigin}/admin/` });
    new CfnOutput(this, 'AmplifyUrl', { value: amplifyOrigin });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AmplifyAppId', { value: app.attrAppId });
    new CfnOutput(this, 'AmplifyBranch', { value: branch.branchName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'PhotosBucket', { value: photos.bucketName });
  }
}
