import { describe, expect, it } from "vitest";
import { isLoginFormTask, verifyWebGoal, type WebGoalState } from "./web-goal-verification.js";

describe("round4-http-outcome: navigation success vs HTTP status & login readiness", () => {
  it("rejects login form readiness when main document returned HTTP 400 Bad Request", () => {
    const prompt = "เปิดหน้าล็อกอินรอผมกรอก";
    expect(isLoginFormTask(prompt)).toBe(true);

    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: false,
      lastActionError: "HTTP 400 error: Error 400 (Bad Request)!!1",
      httpStatus: 400,
      currentUrl: "https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn",
      currentTitle: "Error 400 (Bad Request)!!1",
      loginFormVisible: false,
    };

    const outcome = verifyWebGoal(prompt, state);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/HTTP 400/);
  });

  it("rejects login form readiness even if loginFormVisible is erroneously true when status is 400", () => {
    const prompt = "ไปหน้าล็อกอินรอผมกรอก";

    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: false,
      lastActionError: "HTTP 400",
      httpStatus: 400,
      currentUrl: "https://accounts.google.com/signin",
      currentTitle: "Error 400 (Bad Request)!!1",
      loginFormVisible: true, // Mocking an edge-case where some DOM element matched a form
    };

    const outcome = verifyWebGoal(prompt, state);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/HTTP 400/);
  });

  it("rejects login form readiness when title contains error message even without explicit httpStatus", () => {
    const prompt = "ไปหน้าล็อกอินรอผมกรอก";

    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      currentUrl: "https://accounts.google.com/signin",
      currentTitle: "Error 400 (Bad Request)!!1",
      loginFormVisible: true,
    };

    const outcome = verifyWebGoal(prompt, state);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/Error 400/);
  });

  it("accepts login form readiness when HTTP 200, no error title, and loginFormVisible is true", () => {
    const prompt = "ไปหน้าล็อกอินรอผมกรอก";

    const state: WebGoalState = {
      actionsAttempted: 1,
      lastActionOk: true,
      lastActionVerified: true,
      httpStatus: 200,
      currentUrl: "https://accounts.google.com/signin",
      currentTitle: "Sign in - Google Accounts",
      loginFormVisible: true,
      domStateChanged: true,
    };

    const outcome = verifyWebGoal(prompt, state);
    expect(outcome.ok).toBe(true);
  });
});
