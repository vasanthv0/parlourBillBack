const { z } = require('zod');
const { email, password } = require('../auth/auth.schemas');
const { KEYS } = require('../../config/features');
const { pageQuery } = require('../../utils/pagination');

const id = z.object({ id: z.string().uuid() });
const nonEmpty = (v) => Object.keys(v).length > 0;

// { 'page.team': false, 'action.services.add': true }: unknown keys are rejected.
const featurePatch = z.record(z.enum(KEYS), z.boolean());

exports.list = { query: z.object({ ...pageQuery, search: z.string().trim().max(60).optional() }) };
exports.byId = { params: id };

exports.create = {
  body: z.object({
    parlourName: z.string().trim().min(2, 'Enter the parlour name').max(120),
    adminName: z.string().trim().min(2, 'Enter the admin name').max(80),
    email,
    password,
    features: featurePatch.optional(),
  }),
};

exports.update = {
  params: id,
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      status: z.enum(['active', 'suspended']),
      features: featurePatch,
    })
    .partial()
    .refine(nonEmpty, 'Nothing to update'),
};

exports.updateOwner = {
  params: id,
  body: z.object({ name: z.string().trim().min(2).max(80), email }).partial().refine(nonEmpty, 'Nothing to update'),
};

exports.resetOwnerPassword = { params: id, body: z.object({ password }) };

exports.remove = { params: id, body: z.object({ confirmName: z.string().trim().min(1, 'Type the parlour name to confirm') }) };
