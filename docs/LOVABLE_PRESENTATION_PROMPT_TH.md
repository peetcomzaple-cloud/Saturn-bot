# Prompt สำหรับ Lovable: Saturn bot presentation

สร้างโปรเจกต์นำเสนอ **Saturn bot** แยกใหม่เพียงหนึ่งโปรเจกต์ในบัญชีที่เจ้าของเปิด dashboard ไว้ เป็นหน้า presentation ที่สวย อ่านง่าย ใช้ routeหลัก `/` ได้ ไม่ต้องเข้าถึงหรือแก้โปรเจกต์ Orbiting Star Chat เดิม ไม่เขียนทับหน้าสนทนาหรือแอปเดิม ไม่เปลี่ยน backend/auth และยังไม่ deploy/publish

## ภาพและแบรนด์

- ใช้ไฟล์โลโก้ดาวเสาร์สีทองยิ้มของเจ้าของที่แนบมากับคำขอนี้ ไม่ต้องสร้างโลโก้หรือเปลี่ยน artwork ใหม่
- คู่สีหลัก **Midnight Navy #14213D + Saturn Gold #D6A24A** พื้น light เป็น Warm Ivory #FFF9EF และ dark เป็น Deep Night #0B1220
- ปุ่มทองใช้ตัวอักษร navy; gold สำหรับข้อความบนพื้นอ่อนใช้ #8A5A15 ให้ตรวจ contrast จริง
- รักษาบุคลิกเป็นผู้ช่วยที่อบอุ่น น่าเชื่อถือ และเป็นระบบ ใช้เส้นวงโคจร/ดาวแบบบางและเคลื่อนไหวอย่างพอดี รองรับ reduced motion
- จัด typography ไทย/อังกฤษให้ดี ไม่มีข้อความล้น มี desktop/mobile layouts และ print CSS สำหรับ export เป็น PDF
- อย่าใส่ปุ่มโทรหรือวิดีโอคอล อย่าทำปุ่มแสดงเหมือนทำงานได้ถ้าไม่มี implementation

## เนื้อหา 8 ส่วน/สไลด์

1. **Saturn bot — Your AI team. Your models. Your workspace.** คำอธิบายไทย: “ทีม AI ที่คุณเลือกโมเดล ใช้ API key ของตัวเอง และกำหนดพื้นที่ทำงานได้”
2. **Choose your brain:** ภาพโครงสร้าง provider/model selection ใช้ชื่อผู้ให้บริการเป็นตัวอักษร ไม่อ้าง partnership หรือว่าโมเดลทุกตัวเชื่อมได้แล้ว
3. **Your workspace:** แผนภาพผู้ใช้ → Saturn app/server → provider/tool ที่เลือก → ผลลัพธ์/ไฟล์ แสดงขอบเขตข้อมูลอย่างตรงไปตรงมา ไม่เขียนว่า100%offline/privateเมื่อใช้cloudAPI
4. **Meet your planets:** ดาว12แบบ ตัวตนบอต หน้าต้อนรับ ไทย/อังกฤษ ใช้ภาพหน้าจอจริงที่ได้รับอนุญาต; ถ้าเป็น concept ให้ติดป้าย “Concept” อย่าแสร้งว่าเป็นภาพ product ที่ทดสอบแล้ว
5. **Control cost intelligently:** อธิบาย model choice, context budget และ cache requests ตาม capability เป็นกลไก ไม่ใช่ผล benchmark ใช้ข้อความ “Not benchmarked yet” แทนกราฟเปอร์เซ็นต์
6. **Where Saturn fits:** เทียบ hosted ChatGPT/Claude chat apps ในแง่แอปที่โฮสต์ให้กับระบบที่เลือกdeploy/providerเอง; เทียบOpenClawโดยยอมรับว่าOpenClawมีBYOkeysและcachingเช่นกัน จุดเสนอของSaturnคือประสบการณ์UI/planet/workflowที่เลือก ไม่ใช่ความเหนือกว่าที่วัดแล้ว; ระบุว่าRakazoคือฐานหลัก
7. **Built in the open:** Development snapshot, code/visual verification scopes และสิ่งที่ยังต้องทดสอบจริง ไม่แสดงว่าcampaignผ่านทั้งหมด ไม่ใช้ตัวเลขtest628เป็นหลักฐานว่าโปรเจกต์ทั้งหมดผ่าน
8. **Follow Saturn bot:** สรุปคุณค่าและสถานะโครงการ เครดิตฐานหลักRakazoหนึ่งบรรทัด พร้อมลิงก์NOTICE/PROVENANCEในรายละเอียด เมื่อGitHubยังไม่ยืนยันว่าขึ้นแล้วให้เขียน “Repository publication pending” แทนปุ่มที่พาไป404

## ข้อเท็จจริงที่ต้องรักษา

Saturn bot เป็นผลิตภัณฑ์ที่ต่อยอดจากRakazoและโค้ดดีไซน์ของเจ้าของ ไม่ได้เขียนระบบทั้งหมดจากศูนย์ มีฐานโค้ดprovider/model connections, agent workspace, conversations/files/tasks และcontext/cache handling แต่repoที่แยกใหม่ยังต้องตรวจruntimeจริง ภาษาไทยขั้นสูงบางส่วนยังใช้fallbackอังกฤษ

ห้ามสร้างตัวเลขประหยัดโทเคน ความเร็ว คะแนนคุณภาพ ผู้ใช้งาน ดาวGitHub รายได้ โลโก้ลูกค้า หรือคำว่า “ดีกว่าทุกเจ้า” ขึ้นเอง ห้ามอ้างAPIฟรีหรือไม่มีโควต้า

แหล่งอ้างอิงสำหรับหมายเหตุท้ายหน้า:
- https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
- https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan
- https://docs.openclaw.ai/gateway/authentication
- https://docs.openclaw.ai/reference/prompt-caching

## ส่งงาน

ส่ง preview URL, รายการหน้า/ส่วนที่สร้าง, screenshots desktop/mobile และภาพสำหรับสไลด์ถ้าระบบรองรับ ระบุว่าส่วนไหนเป็นconceptและส่วนไหนใช้ภาพproductจริง ห้ามส่งcredentials/privateURLsหรือเผยแพร่เอง หากทำปุ่มPrint/PDFต้องเรียกใช้งานได้จริงและมีprintlayout ไม่ทำปุ่มexportหลอก
