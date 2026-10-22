// npm run hash-password -- 'mein passwort'  → value for users.<name>.password in the config file
import { hashPassword } from './auth';

const pw = process.argv[2];
if (!pw) { console.error("Aufruf: npm run hash-password -- 'passwort'"); process.exit(1); }
console.log(hashPassword(pw));
