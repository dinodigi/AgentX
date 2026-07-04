import { NextRequest } from "next/server";
import { getProjectRole } from "@/lib/access";
import { exportProject } from "@/lib/manifest";

/** Manifest download for operators (same document as the export_project tool). */
export async function GET(req: NextRequest) {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  const role = await getProjectRole(projectId);
  if (role !== "operator") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const manifest = await exportProject(projectId);
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${manifest.project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-manifest.json"`,
    },
  });
}
