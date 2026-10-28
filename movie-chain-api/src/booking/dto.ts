import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';

const contact = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254),
    phone: z.string().regex(/^\+\d{8,15}$/).optional(),
  })
  .strict();

/**
 * PCI: there is no field for a card number, CVV or expiry, and the schema is
 * strict, so sending one is a 400 — never silently accepted, never stored.
 * A card is a TOKEN from the provider's hosted fields (SAQ-A).
 */
export class CreateBookingDto extends createZodDto(
  z
    .object({
      hold_token: z.string().min(20).max(4096),
      payment_method: z.enum(['mpesa', 'card']),
      phone: z.string().regex(/^\+254[17]\d{8}$/, 'an M-Pesa number, e.g. +2547XXXXXXXX').optional(),
      card_token: z.string().regex(/^tok_[A-Za-z0-9]+_\d{4}$/, 'a token from the payment provider’s hosted fields').optional(),
      contact,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.payment_method === 'mpesa' && !v.phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'required for M-Pesa' });
      if (v.payment_method === 'card' && !v.card_token) ctx.addIssue({ code: 'custom', path: ['card_token'], message: 'required for card' });
    }),
) {}

/** FR-57: the same pipeline at the counter, settled immediately. */
export class BoxOfficeSaleDto extends createZodDto(
  z
    .object({
      hold_token: z.string().min(20).max(4096),
      tender_type: z.enum(['cash', 'card_terminal', 'mpesa_till']),
      contact: contact.optional(),
    })
    .strict(),
) {}

export class CancelBookingDto extends createZodDto(
  z
    .object({
      // omitted = every seat still live on the booking
      seat_ids: z.array(z.uuid()).min(1).max(10).optional(),
    })
    .strict(),
) {}

export class BookingLookupQuery extends createZodDto(
  z
    .object({
      reference: z.string().trim().min(4).max(20).optional(),
      email: z.email().max(254).optional(),
    })
    .strict(),
) {}

export class ListBookingsQuery extends createZodDto(
  z
    .object({
      before: z.iso.datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    })
    .strict(),
) {}
