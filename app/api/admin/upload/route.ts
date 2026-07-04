import { NextRequest } from "next/server";
import { getProjectRole } from "@/lib/access";
import { uploadAsset } from "@/lib/r2";

/**
 * Admin asset upload. Clerk-authed (unlike the token-authed MCP/delivery
 * routes). Accepts multipart form-data { projectId, file }, stores in R2,
 * returns { id, url } for the form to reference.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  const file = form.get("file");
  if (!projectId || !(file instanceof File)) {
    return Response.json({ error: "projectId and file required" }, { status: 400 });
  }

  const role = await getProjectRole(projectId);
  if (!role) return Response.json({ error: "unauthorized" }, { status: 401 });

  const asset = await uploadAsset({
    projectId,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    bytes: Buffer.from(await file.arrayBuffer()),
  });
  return Response.json({ id: asset.id, url: asset.url });
}
