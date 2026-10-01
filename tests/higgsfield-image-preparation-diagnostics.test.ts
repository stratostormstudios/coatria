import test from 'node:test';
import assert from 'node:assert/strict';
import {isAllowedPreparationDiagnostic as allowed} from '../src/lib/higgsfield-image-preparation';
const jpeg='[swscaler @ 0x123AbC] deprecated pixel format used, make sure you did set range correctly\n';
const webp='[webp @ 000001abC] skipping unsupported chunk: XMP \n';
test('only complete bounded native metadata/range notices for their exact format are accepted',()=>{
 for(const format of ['png','jpeg','webp'] as const) assert.equal(allowed(format,Buffer.alloc(0)),true);
 assert.equal(allowed('jpeg',Buffer.from(jpeg)),true);
 assert.equal(allowed('jpeg',Buffer.from(jpeg.replace('\n','\r\n'))),true);
 assert.equal(allowed('webp',Buffer.from(webp)),true);assert.equal(allowed('webp',Buffer.from(webp+webp)),true);
 assert.equal(allowed('png',Buffer.from(jpeg)),false);assert.equal(allowed('webp',Buffer.from(jpeg)),false);assert.equal(allowed('jpeg',Buffer.from(webp)),false);
 for(const value of [jpeg+jpeg,jpeg+'\n',jpeg+'damaged image\n','warning\n'+jpeg,jpeg.slice(0,-1),jpeg+'\0']) assert.equal(allowed('jpeg',Buffer.from(value)),false);
 for(const value of [webp.repeat(3),webp+'\n',webp+'damaged image\n',webp.replace('XMP ','ICCP'),webp.slice(0,-1),webp+'\0']) assert.equal(allowed('webp',Buffer.from(value)),false);
 assert.equal(allowed('webp',Buffer.alloc(65537)),false);
});
