<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('posts', function (Blueprint $table): void {
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
            $table->foreignId('author_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('editor_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('category_id')->constrained('categories')->restrictOnDelete();
            $table->timestamps();
            $table->unique(['author_id', 'title']);
            $table->index(['published_at', 'status'], 'post_pub_status_idx');
            $table->index('title');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('posts');
    }
};
