// Entry point for demo project
import { formatEmail } from './utils';
import { createUser } from './users';
import { handleRequest } from './api';

console.log('PRISM Demo Project');
console.log(formatEmail('demo', 'prism.dev'));

const user = createUser({ id: '42', name: 'Alice' });
console.log(user);
