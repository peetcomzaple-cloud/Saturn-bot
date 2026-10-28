import {describe,expect,it} from 'vitest';
import {ApiErrorInspection,isApiErrorReportTask} from './api-error-inspection.js';
import {verifyWebGoal} from './web-goal-verification.js';

const actual='เข้าไปที่หน้า http://portal.argon-fixture.local:18080/errors/partial-api-fail ตรวจสอบข้อความในหน้าเว็บว่าทำไมตัวเลขรายได้จึงไม่แสดงผล แล้วรายงานรหัสข้อผิดพลาดของ API (/api/critical-metrics) ตามจริงโดยห้ามสร้างตัวเลขรายได้เองครับ';

describe('rendered page text is distinct from a direct JSON endpoint',()=>{
 it.each([actual,
  'อ่านเนื้อหาในหน้าเว็บ https://service.example.test/dashboard แล้วรายงานข้อผิดพลาด API ที่แสดง',
  'Read the text displayed on the page https://service.example.test/dashboard and report the API error',
 ])('does not require an HTML document to become a JSON API error: %s',prompt=>{
  expect(isApiErrorReportTask(prompt)).toBe(false);
  expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:true,lastActionVerified:true,
   navigationOnly:true,currentUrl:'http://portal.argon-fixture.local:18080/errors/partial-api-fail',
   domStateChanged:true,browserClickAttempted:false}).ok).toBe(true);
 });
 it('still rejects a failed main navigation without recovered page evidence',()=>{
  expect(verifyWebGoal(actual,{actionsAttempted:1,lastActionOk:false,currentUrl:'http://fixture.test/dashboard'}).ok).toBe(false);
 });
 it('keeps the JSON response proof requirement for a direct API request',()=>{
  const prompt='Inspect the API endpoint https://service.example.test/data and report the error response';
  expect(isApiErrorReportTask(prompt)).toBe(true);
  expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:true,currentUrl:'https://service.example.test/data',
   domStateChanged:true,apiErrorInspection:new ApiErrorInspection()}).ok).toBe(false);
 });
 it.each([
  actual+' และตรวจสอบ API endpoint แล้วรายงาน response body',
  'Read the text displayed on the page https://service.example.test/dashboard and inspect the raw API response and report its error',
  'Read the text displayed on the page https://service.example.test/dashboard and check the API response and report its error',
  'อ่านเนื้อหาในหน้าเว็บ https://service.example.test/dashboard แล้วตรวจสอบการตอบกลับของ API และรายงานข้อผิดพลาด',
 ])('keeps direct response proof when both goals were requested: %s',prompt=>{
  expect(isApiErrorReportTask(prompt)).toBe(true);
  expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:true,currentUrl:'https://service.example.test/dashboard',
   domStateChanged:true,apiErrorInspection:new ApiErrorInspection()}).ok).toBe(false);
 });
});
