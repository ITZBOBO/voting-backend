import { verifyToken, isTokenBlacklisted } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [type, token] = header.split(' ');
    if (type !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing Authorization token' });

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: 'Token has been revoked/logged out' });
    }

    const decoded = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { roles: { include: { role: true } }, department: true },
    });

    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid user' });

    req.user = {
      id: user.id,
      matricNo: user.matricNo,
      departmentId: user.departmentId,
      department: user.department?.name ?? null,
      roles: user.roles.map((ur) => ur.role),
    };

    // pass the raw token so we can blacklist it on logout
    req.token = token;

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized', details: e.message });
  }
}

export function requireRole(roleNames) {
  const required = Array.isArray(roleNames) ? roleNames : [roleNames];
  return (req, res, next) => {
    const userRoles = (req.user?.roles || []).map((r) => r.name);
    const ok = required.some((r) => userRoles.includes(r));
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

export function forbidVotingForAdmins(req, res, next) {
  const roles = req.user?.roles || [];
  const isAdmin = roles.some((r) => r.isAdminRole || ['admin', 'super_admin'].includes(r.name));
  if (isAdmin) return res.status(403).json({ error: 'Admins cannot vote' });
  next();
}
