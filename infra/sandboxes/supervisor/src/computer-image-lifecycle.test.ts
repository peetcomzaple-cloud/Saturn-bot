import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  buildImage: vi.fn(),
  followProgress: vi.fn(),
  existsSync: vi.fn(),
  listContainers: vi.fn(),
  createContainer: vi.fn(),
  getContainer: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    getImage() {
      return { inspect: mocks.inspectImage };
    }
    buildImage = mocks.buildImage;
    modem = { followProgress: mocks.followProgress };
    listContainers = mocks.listContainers;
    createContainer = mocks.createContainer;
    getContainer = mocks.getContainer;
  },
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  mocks.existsSync.mockImplementation(actual.existsSync);
  return { ...actual, existsSync: mocks.existsSync };
});
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: vi.fn() }));

const selected = `sha256:${"a".repeat(64)}`;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
  mocks.existsSync.mockImplementation(actualFs.existsSync);
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("DATA_DIR", "/tmp/fixture-image-selection");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "fixture-token");
  vi.stubEnv("RAKAZO_COMPUTER_IMAGE", selected);
  mocks.listContainers.mockResolvedValue([]);
  mocks.createContainer.mockResolvedValue({ id: "created", start: vi.fn() });
});
afterEach(() => vi.unstubAllEnvs());

async function provision() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      botId: "bot",
      spaceId: "space",
      homePath: "/tmp/fixture-image-selection/homes/bot",
    }),
  });
}

describe("configured computer image lifecycle", () => {
  it("uses the selected available image for new containers without a build", async () => {
    mocks.inspectImage.mockResolvedValue({ Id: selected });
    const response = await provision();
    expect(response.status).toBe(200);
    expect(mocks.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ Image: selected }),
    );
    expect(mocks.buildImage).not.toHaveBeenCalled();
  });

  it.each([404, 403, 500])(
    "never auto-builds an explicit image after inspection error %s",
    async (statusCode) => {
      const { ensureComputerImage } = await import("./index.js");
      mocks.existsSync.mockReturnValue(true);
      mocks.inspectImage.mockRejectedValue(
        Object.assign(new Error("image inspection failed"), { statusCode }),
      );
      await expect(ensureComputerImage()).rejects.toThrow("refusing to build a replacement");
      expect(mocks.buildImage).not.toHaveBeenCalled();
      expect(mocks.createContainer).not.toHaveBeenCalled();
    },
  );

  it("retains historical default image auto-build", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_IMAGE", undefined);
    const { ensureComputerImage } = await import("./index.js");
    mocks.existsSync.mockReturnValue(true);
    mocks.inspectImage
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ Id: "default-built" });
    mocks.buildImage.mockResolvedValue({});
    mocks.followProgress.mockImplementation((_stream, callback) => callback(null));
    await ensureComputerImage();
    expect(mocks.buildImage).toHaveBeenCalledWith(expect.anything(), {
      t: "saturn-bot/computer:local",
    });
  });

  it.each(["sha256:existing-image", undefined])(
    "reports actual resumed image %s without replacing it",
    async (actualImage) => {
      const existing = {
        id: "existing",
        start: vi.fn(),
        inspect: vi.fn().mockResolvedValue({
          Image: actualImage,
          Config: {
            Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
          },
          State: { Running: true },
        }),
      };
      mocks.listContainers.mockResolvedValue([{ Id: "existing" }]);
      mocks.getContainer.mockReturnValue(existing);
      const response = await provision();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "existing",
        resumed: true,
        image: actualImage ?? null,
        configuredImage: selected,
      });
      expect(mocks.inspectImage).not.toHaveBeenCalled();
      expect(mocks.createContainer).not.toHaveBeenCalled();
      expect(mocks.buildImage).not.toHaveBeenCalled();
      expect(existing.start).not.toHaveBeenCalled();
    },
  );
});
