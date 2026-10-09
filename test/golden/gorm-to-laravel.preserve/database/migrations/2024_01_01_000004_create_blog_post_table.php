<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_post', function (Blueprint $table): void {
            $table->id();
            $table->uuid('public_id')->unique();
            $table->string('title', 200);
            $table->text('body');
            $table->enum('status', ['draft', 'published'])->default('draft');
            $table->decimal('rating', 4, 2)->nullable();
            $table->integer('view_count')->default(0);
            $table->boolean('is_featured')->default(false);
            $table->dateTime('published_at')->useCurrent();
            $table->jsonb('metadata')->default('{}');
            $table->foreignId('author_id')->constrained('auth_user')->cascadeOnDelete();
            $table->foreignId('editor_id')->nullable()->constrained('auth_user')->nullOnDelete();
            $table->foreignId('category_id')->constrained('blog_category')->restrictOnDelete();
            $table->timestamps();
            $table->index('title');
            $table->unique(['author_id', 'title'], 'uniq_post_author_title');
            $table->index(['published_at', 'status'], 'post_pub_status_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_post');
    }
};
