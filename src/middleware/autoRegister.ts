import { Context } from "telegraf";
import { UserService } from "../services/UserService";

export async function autoRegisterMiddleware(ctx: Context, next: () => Promise<void>) {
    console.log("📨 Update received:", ctx.updateType, ctx.message);

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
