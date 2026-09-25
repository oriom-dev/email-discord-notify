import { NodeHtmlMarkdown } from 'node-html-markdown';
import PostalMime, { decodeWords } from 'postal-mime';

// 処理用の累積変数の型
type AttachmentAccumulator = {
	filesToUpload: unknown[];
	cidMap: Map<string, string>;
	currentSize: number;
};

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			// メールの転送
			message.forward(env.FORWARD_TO_EMAIL)

			// メールの解析
			const parser = new PostalMime();
			const rawEmail = await new Response(message.raw).arrayBuffer();
			const parsedEmail = await parser.parse(rawEmail);

			const { headers, subject, html, text, attachments, date } = parsedEmail;

			// 添付ファイルの処理
			const MAX_DISCORD_SIZE = 10 * 1024 * 1024;
			const SAFE_MARGIN = 50000;

			const { filesToUpload, cidMap } = (attachments ?? []).reduce<AttachmentAccumulator>((acc, file) => {
				// contentの型に応じたサイズ計算
				const fileSize = typeof file.content === 'string'
					? new TextEncoder().encode(file.content).length
					: file.content.byteLength;
				// ファイル名が null/undefined の場合のフォールバック
				const filename = file.filename ?? `unnamed_${Math.random().toString(36).substring(2, 8)}`;

				// Content-ID のマッピング
				if (file.contentId) {
					const cleanCid = file.contentId.replace(/^<|>$/g, '');
					acc.cidMap.set(cleanCid, filename);
				}

				// サイズチェック
				if (acc.currentSize + fileSize < MAX_DISCORD_SIZE - SAFE_MARGIN) {
					acc.filesToUpload.push({ ...file, filename });
					acc.currentSize += fileSize;
				}

				return acc;
			}, { filesToUpload: [], cidMap: new Map(), currentSize: 0 });

			const rawContent = text ?? (html
				? NodeHtmlMarkdown.translate(html).replace(/!\[(.*?)\]\((cid:.*?)(?: ".*?")?\)/g, (match, alt, src) => {
					const cid = src.replace('cid:', '');
					const filename = cidMap.get(cid) ?? cid;
					const altText = alt || '画像';
					return ` **[${altText}: ${filename}]** `;
				})
				: '(本文なし)');

			const cleanContent = removeReplyContent(rawContent);

			const finalDescription = cleanContent.length > 3500
				? `${cleanContent.substring(0, 3500)}\n......`
				: cleanContent;

			const authorName = decodeWords(
				headers.find((h) => h.key === "x-original-from")?.value ??
				headers.find((h) => h.key === "from")?.value ??
				'Unknown sender'
			);

			const headerTo = decodeWords(
				headers.find((h) => h.key === "to")?.value ?? 'Unknown Recipient'
			).replaceAll(/discord/ig, "dis*ord");

			// Discord Payload
			const payload = {
				username: headerTo,
				content: `**${subject ?? '(件名なし)'}**`,
				embeds: [{
					author: {
						name: authorName
					},
					title: subject,
					description: finalDescription,
					timestamp: date,
					...(filesToUpload.length > 0 && {
						footer: {
							text: `📎添付ファイル数: ${filesToUpload.length}`
						}
					}),
				}],
			};

			// FormDataの構築
			const formData = new FormData();
			formData.append('payload_json', JSON.stringify(payload));

			filesToUpload.forEach((file, index) => {
				const blob = new Blob([file.content], { type: file.mimeType });
				formData.append(`files[${index}]`, blob, file.filename);
			});

			// 送信
			const response = await fetch(env.DISCORD_WEBHOOK_URL, {
				method: "POST",
				body: formData,
			});

			if (!response.ok) {
				console.error(`Discord Error: ${response.status}`, await response.text());
			}

		} catch (e) {
			console.error("Error processing email:", e);
		}
	}
};

function removeReplyContent(content: string): string {
	if (!content) return "";

	const lines = content.split('\n');
	const resultLines: string[] = [];

	// 引用ヘッダーとみなす正規表現パターン
	const quotePatterns = [
		/^On\s.+wrote:$/i,                           // English: On [Date] [Name] wrote:
		/^-----Original Message-----$/i,             // Outlook style
		/^From:\s.+$/i,                              // Generic headers (From: xxx)
		/^________________________________$/i,       // Common dividers
		/^20[0-9]{2}年.+wrote:$/i,                   // Japanese style 1
		/^20[0-9]{2}\/.+\/.+\s.+<.+@.+>$/i,          // Japanese style 2
		/^> On\s.+wrote:$/i,                         // Markdown quoted English
		/^> 20[0-9]{2}年.+wrote:$/i,                 // Markdown quoted Japanese
	];

	for (const line of lines) {
		const trimmedLine = line.trim();

		if (quotePatterns.some(pattern => pattern.test(trimmedLine))) {
			break;
		}

		resultLines.push(line);
	}

	return resultLines.join('\n').trim();
}
