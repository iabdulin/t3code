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

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");

function shell(id: string, title: string, tags?: string[]) {
  const { source } = makeThreadFixture({ id: ThreadId.make(id), projectId, title, environmentId });
  return presentThreadShell(environmentId, { ...source, ...(tags ? { tags } : {}) });
}

describe("sidebar attention groups", () => {
  it("folds a group to its header and keeps the full count, also over the open thread", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: false });
    stack.defer(() => localStorage.removeItem("t3code:sidebar:needs-you-expanded"));
    const asking = shell("asking", "Asking thread", [THREAD_ATTENTION_TAGS["needs-you"]]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      asking,
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
      threadRef: { environmentId, threadId: asking.id },
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const needsYou = screen.getByTestId("sidebar-needs-you-shelf-toggle");
    await expect.element(needsYou).toHaveTextContent("Needs you1");
    await expect
      .element(screen.getByTestId("sidebar-other-shelf-toggle"))
      .toHaveTextContent("Other1");
    await expect
      .element(screen.getByTestId("sidebar-nothing-needed-shelf-toggle"))
      .toHaveTextContent("Nothing needed1");
    await expect
      .element(screen.getByRole("button", { name: /^Asking thread/ }))
      .toHaveAttribute("aria-current", "page");

    await userEvent.click(needsYou);

    await expect.element(screen.getByText("Asking thread")).not.toBeInTheDocument();
    await expect.element(needsYou).toHaveTextContent("Needs you1");
    await expect.element(screen.getByText("Quiet thread").first()).toBeVisible();
  });
});
