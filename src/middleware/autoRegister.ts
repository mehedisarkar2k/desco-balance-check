import { Context } from "telegraf";
import { UserService } from "../services/UserService";

export async function autoRegisterMiddleware(ctx: Context, next: () => Promise<void>) {
    // What arrived, not what it said: full updates put names, phone numbers
    // and account numbers into the platform's logs.
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : null;
    const summary = text?.startsWith("/") ? text.split(/\s/)[0] : text !== null ? `text (${text.length} chars)` : "";
    console.log(`📨 ${ctx.updateType} from ${ctx.from?.id ?? "unknown"} ${summary}`.trim());

    // Auto-register user on any interaction
    if (ctx.from) {
        await UserService.findOrCreate(ctx.from.id, {
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
        });
    }

    await next();
}
