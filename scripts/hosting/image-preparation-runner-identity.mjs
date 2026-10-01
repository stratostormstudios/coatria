/** Pure finite runner identity. No IO, credentials or qualification authority. */
import {createHash} from 'node:crypto';
export const imagePreparationRunnerCanonical=value=>Array.isArray(value)?'['+value.map(imagePreparationRunnerCanonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+imagePreparationRunnerCanonical(item)).join(',')+'}':JSON.stringify(value);
/** The receipt locator/hash alone is excluded to avoid a receipt/config cycle. */
export function imagePreparationRunnerConfigurationHash(configuration){const {qualification:_receipt,...identity}=configuration;return createHash('sha256').update('coatria:image-preparation-runner:v1\n'+imagePreparationRunnerCanonical(identity)).digest('hex');}
