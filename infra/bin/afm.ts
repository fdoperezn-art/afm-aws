#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { AfmStack } from '../lib/afm-stack';

const app = new App();
// La nueva experiencia de AWS solo permite crear recursos en la Región del proyecto (us-east-2).
const stack = new AfmStack(app, 'AfmStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-2' },
  description: 'AFM · Aquí falta la muni — mapa ciudadano de Conchalí',
  terminationProtection: true,
});
Tags.of(stack).add('project', 'afm-conchali');
