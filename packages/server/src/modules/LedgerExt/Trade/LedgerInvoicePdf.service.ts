import { randomBytes } from 'crypto';
import * as moment from 'moment-timezone';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { renderInvoicePaperTemplateHtml } from '@bigcapital/pdf-templates';
import { ChromiumlyTenancy } from '@/modules/ChromiumlyTenancy/ChromiumlyTenancy.service';
import { SaleInvoicePdfTemplate } from '@/modules/SaleInvoices/queries/SaleInvoicePdfTemplate.service';
import { S3_CLIENT } from '@/modules/S3/S3.module';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { TradeDocumentsService } from './TradeDocuments.service';
import { INVOICES } from './trade.config';

/** How long the link to a rendered invoice stays good, in seconds. */
export const INVOICE_PDF_LINK_SECONDS = 300;

/**
 * Renders an invoice as a PDF with Bigcapital's invoice template and the
 * organization's branding, stores the file, and answers a signed link to it.
 */
@Injectable()
export class LedgerInvoicePdfService {
  constructor(
    private readonly cls: ClsService,
    private readonly config: ConfigService,
    private readonly locator: ExtServiceLocator,
    private readonly documents: TradeDocumentsService,
    private readonly workspaces: LedgerWorkspacesService,
  ) {}

  public async link(
    invoiceId: number,
  ): Promise<{ url: string; fileName: string }> {
    const invoice = await this.documents.get(INVOICES, invoiceId);
    const organizationId: string = this.cls.get('organizationId');
    const workspace = await this.workspaces.findByOrganization(organizationId);
    const money = (amount: string) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: workspace?.baseCurrency || 'USD',
      }).format(Number(amount));
    const day = (date: string | null) =>
      date
        ? moment.utc(date, 'YYYY-MM-DD', true).format('MMM D, YYYY')
        : undefined;
    // What was paid, not the total less the balance: a voided invoice has
    // a balance of zero and nothing paid.
    const paid = invoice.payments
      .reduce((sum, payment) => sum + Number(payment.amount), 0)
      .toFixed(2);
    const customer = invoice.party;

    const templates = await this.locator.resolve(SaleInvoicePdfTemplate);
    const branding = await templates.getInvoicePdfTemplate();
    const html = renderInvoicePaperTemplateHtml({
      ...(branding.attributes as any),
      invoiceNumber: invoice.number,
      dateIssue: day(invoice.postedOn),
      dueDate: day(invoice.dueOn),
      showDueDate: Boolean(invoice.dueOn),
      total: money(invoice.amount),
      subtotal: money(invoice.amount),
      paymentMade: money(paid),
      dueAmount: money(invoice.balance),
      statement: invoice.note ?? undefined,
      lines: invoice.entries.map((entry) => ({
        item: entry.item ?? entry.account?.name ?? '',
        description: entry.description ?? '',
        rate: money(entry.rate),
        quantity: entry.quantity,
        total: money(entry.amount),
      })),
      taxes: [],
      // An invoice here carries no discount and no terms text of its own, so
      // the template's zero discount row and stock terms are left off.
      discount: '',
      showDiscount: false,
      showTermsConditions: false,
      customerAddress: [
        customer?.companyName,
        customer?.individualName,
        customer?.addressString,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    const chromium = await this.locator.resolve(ChromiumlyTenancy);
    const buffer = await chromium.convertHtmlContent(html);

    const fileName = `Invoice-${invoice.number ?? invoice.id}.pdf`;
    const bucket = this.config.get('s3')?.bucket;
    const key = `ledger/${organizationId}/invoices/${invoice.id}-${randomBytes(8).toString('hex')}.pdf`;
    const s3 = this.locator.get<S3Client>(S3_CLIENT);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`,
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: INVOICE_PDF_LINK_SECONDS },
    );
    return { url, fileName };
  }
}
