#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { AfmStack } from '../lib/afm-stack';
import { AfmCiStack } from '../lib/ci-stack';

const app = new App();
// La nueva experiencia de AWS solo permite crear recursos en la Región del proyecto (us-east-2).
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-2' };

const stack = new AfmStack(app, 'AfmStack', {
  env,
  description: 'AFM · Aquí falta la muni — mapa ciudadano de Conchalí',
  terminationProtection: true,
});

// Permisos para GitHub Actions. Se despliega a mano: npx cdk deploy AfmCiStack
const ci = new AfmCiStack(app, 'AfmCiStack', {
  env,
  description: 'AFM · despliegue automático desde GitHub Actions (OIDC)',
  repository: 'fdoperezn-art/afm-aws',
  branch: 'main',
  terminationProtection: true,
});

for (const s of [stack, ci]) Tags.of(s).add('project', 'afm-conchali');
