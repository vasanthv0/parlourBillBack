const z = require('zod').z;

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const offsetOf = ({ page, limit }) => (page - 1) * limit;
const pageMeta = ({ page, limit }, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

module.exports = { pageQuery, offsetOf, pageMeta };
