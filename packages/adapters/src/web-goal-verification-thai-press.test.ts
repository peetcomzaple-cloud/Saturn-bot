import {describe,expect,it} from 'vitest';
import {isClickTask,verifyWebGoal} from './web-goal-verification.js';

const prompt='เปิดหน้า http://portal.argon-fixture.local:18080/errors/waf-403 เมื่อพบว่าถูกบล็อกด้วย HTTP 403 WAF ให้เปลี่ยนไปเปิดหน้าสำเนาสาธารณะที่ได้รับอนุญาต http://portal.argon-fixture.local:18080/articles/public-mirror แล้วบอกรหัสยืนยันสำเนาสาธารณะและความเร็วเฉลี่ยโครงข่ายครับ';

describe('Thai press intent respects word boundaries',()=>{
 it.each([prompt,'ถูกบล็อกด้วย','ถูกด้วย','บล็อคด้วย','บล๊อกด้วย','เมื่อถูกบล็อกด้วยHTTP403ให้เปิดสำเนา','ไม่รู้สึกกดดัน'])(
  'does not invent a press command: %s',text=>expect(isClickTask(text)).toBe(false));
 it.each(['กดปุ่ม','ช่วยกดปุ่ม','แล้วกดปุ่ม','กดด้วย','ช่วยกดด้วยครับ','กดEnter','กดOK','ช่วยกดSign in','กดปุ่มOK','กดปุ่่ม','คลิกปุ่ม','เลือกด้วย','กดดู','กดไป','กดๆ ปุ่มนี้','กด๑เพื่อดำเนินการต่อ'])(
  'preserves actual press and click commands: %s',text=>expect(isClickTask(text)).toBe(true));
 it('accepts the observed public mirror without demanding an extra click',()=>{
  expect(verifyWebGoal(prompt,{
   actionsAttempted:2,lastActionOk:true,lastActionVerified:true,navigationOnly:true,
   initialUrl:'http://portal.argon-fixture.local:18080/errors/waf-403',
   currentUrl:'http://portal.argon-fixture.local:18080/articles/public-mirror',
   domStateChanged:true,screenChanged:true,browserClickAttempted:false,
  }).ok).toBe(true);
 });
 it('still requires a real click when explicitly requested',()=>{
  expect(verifyWebGoal('กดปุ่มดาวน์โหลด',{
   actionsAttempted:1,lastActionOk:true,lastActionVerified:true,navigationOnly:true,
   currentUrl:'http://fixture.test/report',domStateChanged:true,browserClickAttempted:false,
  }).ok).toBe(false);
 });
});
