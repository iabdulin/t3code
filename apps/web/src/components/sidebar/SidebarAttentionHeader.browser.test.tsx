import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  THREAD_ATTENTION_TAGS,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock("../../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+]", command: "thread.next" },
    { key: "mod+shift+[", command: "thread.previous" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");

function shell(id: string, title: string, tags?: string[]) {
  const { source } = makeThreadFixture({ id: ThreadId.make(id), projectId, title, environmentId });
  return presentThreadShell(environmentId, { ...source, ...(tags ? { tags } : {}) });
}

describe("sidebar attention groups", () => {
  it("folds a group to its header and the open thread, and navigates in the visible order", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: false });
    stack.defer(() => localStorage.removeItem("t3code:sidebar:other-expanded"));
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const open = shell("open", "Open thread");
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell("asking", "Asking thread", [THREAD_ATTENTION_TAGS["needs-you"]]),
      open,
      shell("quiet", "Quiet thread"),
      shell("done", "Done thread", [THREAD_ATTENTION_TAGS["nothing-needed"]]),
    ]);
    vi.mocked(useProjects).mockReturnValue([
      {
        id: projectId,
        environmentId,
        title: "project",
        workspaceRoot: "/projects/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        scripts: [],
      },
    ]);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId, projectId },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId, threadId: open.id },
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const other = screen.getByTestId("sidebar-other-shelf-toggle");
    await expect
      .element(screen.getByTestId("sidebar-needs-you-shelf-toggle"))
      .toHaveTextContent("Needs you1");
    await expect.element(other).toHaveTextContent("Other2");
    await expect
      .element(screen.getByTestId("sidebar-nothing-needed-shelf-toggle"))
      .toHaveTextContent("Nothing needed1");
    await expect.element(screen.getByText("Quiet thread").first()).toBeVisible();

    await userEvent.click(other);

    await expect.element(screen.getByText("Quiet thread")).not.toBeInTheDocument();
    await expect.element(other).toHaveTextContent("Other2");
    await expect
      .element(screen.getByRole("button", { name: /^Open thread/ }))
      .toHaveAttribute("aria-current", "page");

    const path = () => screen.router?.history.location.pathname;
    await userEvent.keyboard("{Control>}{Shift>}]{/Shift}{/Control}");
    await vi.waitFor(() => expect(path()).toBe(`/${environmentId}/done`));
    await userEvent.keyboard("{Control>}{Shift>}[[{/Shift}{/Control}");
    await vi.waitFor(() => expect(path()).toBe(`/${environmentId}/asking`));
  });
});
