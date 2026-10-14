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
            $table->bigIncrements('Id');
            $table->uuid('public_id')->unique();
            $table->string('Title', 200);
            $table->text('Body');
            $table->enum('Status', ['Draft', 'Published'])->default('Draft');
            $table->decimal('Rating', 4, 2)->nullable();
            $table->integer('view_count')->default(0);
            $table->boolean('is_featured')->default(false);
            $table->dateTime('published_at')->useCurrent();
            $table->jsonb('Metadata')->default('{}');
            $table->foreignId('author_id')->constrained('auth_user', 'Id')->cascadeOnDelete();
            $table->foreignId('editor_id')
                ->nullable()
                ->constrained('auth_user', 'Id')
                ->nullOnDelete();
            $table->foreignId('category_id')
                ->constrained('blog_category', 'Id')
                ->restrictOnDelete();
            $table->timestamps();
            $table->index('Title');
            $table->unique(['author_id', 'Title'], 'uniq_post_author_title');
            $table->index(['published_at', 'Status'], 'post_pub_status_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_post');
    }
};
