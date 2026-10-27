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
