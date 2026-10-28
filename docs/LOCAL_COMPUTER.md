# Local Computer (Linux desktop container)

Saturn bot can run its computer-assisted work on the same machine as the app. In this mode a
"computer" is a Linux desktop **container** started through a Docker-compatible engine. It is not
a Windows VM and not a new hypervisor.

> Status: implemented and unit-tested, not yet verified on a running stack. See
> [validation boundaries](VALIDATION_STATUS.md). The Saturn bot images are not published yet.

## Requirements

- Docker Desktop, OrbStack, or Docker Engine with the Compose plugin, already installed and
  running. Saturn bot never installs or restarts Docker for you.
- Memory for Saturn bot's own services plus each computer you run. Setup keeps roughly 3 GB aside
  for the services when it compares one computer's limit with Docker's total memory. That figure
  is a planning estimate, not a measurement, and it does not cap the combined memory of several
  computers running at once.
- Internet access and your own provider credentials for cloud models. Calls to cloud models are
  billed by the provider. Offline models are not included.
- Docker Desktop on macOS and Windows already runs inside its own Linux VM. Container limits
  live inside the resources that VM, or the Linux host, gives Docker.

## Set up

1. Open Saturn bot and choose **This computer**.
2. Optionally open **Advanced** and set memory (GB, 1 to 256) and CPUs (0.5 to 64, in steps of
   0.5) per computer. Defaults are 2 GB and 2 CPUs. Out-of-range values are refused with a message.
3. Choose **Continue**. Saturn bot checks Docker, compares the limits with what Docker reports,
   starts the stack, waits until it answers, then opens the app.

To use a server you already run, choose **Existing instance** instead. That path is unchanged.

## What the limits mean

- They are **per computer**, not a total for the host or for Docker.
- They apply to computers created after the stack next starts with the new values. Running
  computers keep the limits they were created with.
- They are passed to the supervisor settings that set the container's memory, memory plus swap
  and CPU quota. The conversion to those values is tested; enforcement on a running computer has
  not been verified yet. Other hardening settings are unchanged by this feature.
- If Docker reports less than a computer needs, setup stops with a message before anything is
  downloaded or started.
- If Docker does **not** report its capacity, the limits could not be checked. Limits above the
  defaults then stop with an explanation, and the defaults proceed with a note that capacity was
  not checked. Nothing is assumed to be enough.
- Disk size is not adjustable.

## Separate from Rakazo

The stack uses the Compose project name `saturn-bot-desktop` (manual compose: `saturn-bot`), so it
does not share services or volumes with a Rakazo stack on the same engine. A stack that an earlier
build created under the old project name is not adopted, migrated, stopped or deleted: its data
stays where it is and a new Saturn bot stack starts empty.

Source development and production Compose templates use `saturn-bot-dev` and `saturn-bot-prod` respectively. The production updater defaults to `/srv/saturn-bot`. These are source defaults, not a migration: existing stacks/data stay where they are. Development/topology computer image tags also use the Saturn namespace. Explicit project/path/image overrides and host ports still need review before running alongside another stack. Saturn registry references are prospective; no image publication or running-stack acceptance is implied.

## Troubleshooting

- *Docker is not installed / not running*: install or start it, then choose **Check again**. You
  can still connect to an existing server.
- *This user cannot access Docker* (Linux): add your user to the `docker` group, sign out and in.
- *Not enough memory*: lower the computer memory, or raise Docker's memory in its settings.
- *Capacity could not be checked*: use the default limits or lower values.
- *Images are not published yet*: build the images from this repository, then point
  `RAKAZO_IMAGE` and `RAKAZO_COMPUTER_IMAGE` in the stack `.env` at them.

## สรุปภาษาไทย

โหมด "This computer" ใช้คอมพิวเตอร์จำลองแบบ Linux desktop container ผ่าน Docker ที่ติดตั้งและเปิดอยู่แล้ว
ไม่ใช่ Windows VM แอปไม่ติดตั้งหรือรีสตาร์ต Docker ให้ ค่า RAM/CPU ใน Advanced เป็นค่าต่อ computer
มีผลกับเครื่องที่สร้างหลังเริ่ม stack ครั้งถัดไป ฟีเจอร์นี้ผ่าน unit test แล้วแต่ยังไม่ได้ตรวจบน stack ที่รันจริง
ถ้า Docker ไม่รายงานทรัพยากร ค่าที่เกินค่าเริ่มต้นจะถูกหยุดพร้อมคำอธิบาย ตัวเลขสำรอง 3 GB เป็นค่าประมาณและไม่ได้จำกัดผลรวมของหลาย computer
Saturn bot ใช้ชื่อ Compose project แยกจาก Rakazo และไม่แตะ stack เดิมที่สร้างไว้ก่อนหน้า
