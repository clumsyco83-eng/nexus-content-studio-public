import { runFirstProductionTest } from './first-production-test.js';

const result = await runFirstProductionTest();
console.log(JSON.stringify(result, null, 2));
