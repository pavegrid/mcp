import { main } from './main.js';
import { message } from './errors.js';
void main().catch(error => { process.stderr.write(message(error) + '\n'); process.exitCode = 1; });
