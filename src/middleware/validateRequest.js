import { ZodError } from "zod";

function normalizeIssues(issues, source) {
  return issues.map((issue) => ({
    source,
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function formatZodError(err, source = "body") {
  if (!(err instanceof ZodError)) return [];
  return normalizeIssues(err.issues || [], source);
}

export function validateRequest(schemas = {}) {
  const { params, query, body } = schemas;

  return (req, res, next) => {
    const details = [];

    if (params) {
      const parsed = params.safeParse(req.params || {});
      if (!parsed.success) {
        details.push(...normalizeIssues(parsed.error.issues, "params"));
      } else {
        req.params = parsed.data;
      }
    }

    if (query) {
      const parsed = query.safeParse(req.query || {});
      if (!parsed.success) {
        details.push(...normalizeIssues(parsed.error.issues, "query"));
      } else {
        req.query = parsed.data;
      }
    }

    if (body) {
      const parsed = body.safeParse(req.body || {});
      if (!parsed.success) {
        details.push(...normalizeIssues(parsed.error.issues, "body"));
      } else {
        req.body = parsed.data;
      }
    }

    if (details.length > 0) {
      return res.status(400).json({
        error: "Validation failed",
        details,
      });
    }

    return next();
  };
}
