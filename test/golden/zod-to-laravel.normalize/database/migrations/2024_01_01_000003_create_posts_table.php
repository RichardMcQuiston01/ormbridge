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
            $table->integer('id')->primary();
            $table->uuid('public_id');
            $table->string('title', 200);
            $table->text('body');
            $table->enum('status', ['draft', 'published'])->default('draft');
            $table->decimal('rating', 4, 2)->nullable();
            $table->integer('view_count')->default(0);
            $table->boolean('is_featured')->default(false);
            $table->dateTime('published_at')->useCurrent();
            $table->jsonb('metadata')->default('{}');
            $table->integer('author_id');
            $table->integer('editor_id')->nullable();
            $table->integer('category_id');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('posts');
    }
};
