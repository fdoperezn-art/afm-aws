#!/usr/bin/env node
// Crea o cambia el código del equipo para /equipo.
// Genera un código aleatorio (AFM-XXXX-XXXX-XXXX, ~60 bits), guarda SOLO su huella scrypt en
// Parameter Store (/afm/equipo/codigo) y muestra el código una vez. El código anterior deja de servir
// en máximo 5 minutos (la API guarda la huella en memoria ese tiempo).
//
// Uso:   node scripts/set-team-code.mjs              (requiere sesión de AWS: aws login)
//        node scripts/set-team-code.mjs --print-only (solo genera código y huella, sin tocar AWS)
import { randomBytes, randomInt, scryptSync } from 'node:crypto';

const PARAM = '/afm/equipo/codigo';
const REGION = process.env.AWS_REGION || 'us-east-2';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para evitar confusiones
const N = 16384;

const block = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const code = `AFM-${block()}-${block()}-${block()}`;
const salt = randomBytes(16);
const hash = scryptSync(code, salt, 32, { N });
const value = `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;

if (process.argv.includes('--print-only')) {
  console.log(JSON.stringify({ code, value }));
  process.exit(0);
}

const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
await new SSMClient({ region: REGION }).send(
  new PutParameterCommand({
    Name: PARAM,
    Value: value,
    Type: 'String', // es una huella, no el código; el parámetro estándar es gratuito
    Overwrite: true,
    Description: 'Huella scrypt del código del equipo AFM (/equipo). Cambiar con scripts/set-team-code.mjs',
  }),
);
console.log(`\nNuevo código del equipo:  ${code}\n`);
console.log('Compártelo solo con el equipo. El código anterior deja de funcionar en máximo 5 minutos.');
