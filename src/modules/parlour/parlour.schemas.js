const { z } = require('zod');

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

exports.update = {
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      phone: z.preprocess(blankToNull, z.string().trim().max(20).nullable()),
      address: z.preprocess(blankToNull, z.string().trim().max(300).nullable()),
      gstNumber: z.preprocess(blankToNull, z.string().trim().max(20).nullable()),
      taxPercent: z.number().min(0, 'Cannot be negative').max(100, 'Cannot exceed 100'),
      // Do the menu prices already contain GST? Only bills made after the change are affected.
      gstPriceMode: z.enum(['exclusive', 'inclusive'], { errorMap: () => ({ message: 'Choose whether prices include GST or not' }) }),
      invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, 'Use 2–8 letters or numbers'),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};
