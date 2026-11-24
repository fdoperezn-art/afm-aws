import { CfnOutput, Duration, Stack, StackProps, aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface CiStackProps extends StackProps {
  /** Repositorio de GitHub, p. ej. "dueño/repo". */
  repository: string;
  /**
   * Identificadores numéricos fijos del dueño y del repositorio en GitHub. GitHub los incluye en el
   * token OIDC (`repo:dueño@ID/repo@ID:…`) y evitan que otro repositorio con el mismo nombre pueda desplegar.
   */
  ownerId: string;
  repositoryId: string;
  /** Rama que puede desplegar. */
  branch: string;
}

/**
 * Permite que GitHub Actions despliegue AFM sin claves guardadas: GitHub obtiene credenciales
 * temporales por OIDC, solo para pushes a la rama indicada del repositorio indicado.
 * Esta pila se despliega a mano (no desde el pipeline), para que el pipeline no pueda ampliar sus propios permisos.
 */
export class AfmCiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const [owner, repo] = props.repository.split('/');
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'afm-github-deploy',
      description: `Despliegue de AFM desde ${props.repository}@${props.branch}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${owner}@${props.ownerId}/${repo}@${props.repositoryId}:ref:refs/heads/${props.branch}`,
        },
      }),
    });

    // CDK: solo puede asumir los roles que creó `cdk bootstrap` (ellos hacen el despliegue real).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
    );
    // Frontend: leer las salidas de la pila y publicar en Amplify.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/AfmStack/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['amplify:CreateDeployment', 'amplify:StartDeployment', 'amplify:GetJob'],
        resources: [`arn:aws:amplify:${this.region}:${this.account}:apps/*/branches/main*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
