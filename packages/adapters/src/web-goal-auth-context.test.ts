import {describe,expect,it} from 'vitest';
import {isClickTask,isLoginFormTask,verifyWebGoal} from './web-goal-verification.js';

const actualPrompt='ลองเปิดหน้า http://portal.argon-fixture.local:18080/errors/bad-flow-400?reset=1 เมื่อพบข้อผิดพลาด HTTP 400 (Flow State Invalid) ของระบบล็อกอิน ให้กู้คืนโดยไปที่หน้าเริ่มต้นที่ถูกต้อง http://portal.argon-fixture.local:18080/errors/flow-entry (หรือใช้ browser_clear_origin_storage สำหรับ origin นี้แล้วโหลดใหม่) จากนั้นบอกรหัสยืนยันการกู้คืน HTTP 400 ที่ได้ครับ';
describe('auth context is not an extra interaction command',()=>{
 it('does not infer a click from the actual T21b contextual system noun',()=>{
  expect(isClickTask(actualPrompt)).toBe(false);
 });
 it('accepts observed entry recovery without an unrequested Login click',()=>{
  expect(verifyWebGoal(actualPrompt,{
   actionsAttempted:2,lastActionOk:true,lastActionVerified:true,navigationOnly:true,
   initialUrl:'http://portal.argon-fixture.local:18080/errors/bad-flow-400?reset=1',
   currentUrl:'http://portal.argon-fixture.local:18080/errors/flow-entry',
   domStateChanged:true,screenChanged:true,loginFormVisible:false,browserClickAttempted:false,
  }).ok).toBe(true);
 });
 it.each(['คลิกลิงก์เข้าสู่ระบบในระบบล็อกอิน','กดปุ่ม Login บนระบบล็อกอิน','ช่วยเข้าสู่ระบบให้สำเร็จ','เข้าสู่ระบบล็อกอิน'])(
  'retains a real click/authentication command: %s',prompt=>expect(isClickTask(prompt)).toBe(true));
 it('retains visible-form proof for a requested login handoff',()=>{
  const prompt='เปิดหน้าล็อกอินรอผมกรอกเอง';
  expect(isLoginFormTask(prompt)).toBe(true);
  expect(verifyWebGoal(prompt,{actionsAttempted:1,lastActionOk:true,lastActionVerified:true,
   currentUrl:'http://fixture.test/login',loginFormVisible:false,domStateChanged:true}).ok).toBe(false);
 });
});
