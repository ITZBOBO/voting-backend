import { ZodError } from 'zod';

export function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse({ body: req.body, params: req.params, query: req.query });
      req.validated = parsed.body;
      next();
    } catch (e) {
      if (e instanceof ZodError) return res.status(400).json({ error: 'Validation error', issues: e.issues });
      return res.status(400).json({ error: 'Bad request' });
    }
  };
}
