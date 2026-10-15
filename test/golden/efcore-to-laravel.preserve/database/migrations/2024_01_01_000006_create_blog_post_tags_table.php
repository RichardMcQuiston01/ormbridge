<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_post_tags', function (Blueprint $table): void {
            $table->foreignId('post_Id')->constrained('blog_post', 'Id')->cascadeOnDelete();
            $table->foreignId('tag_Id')->constrained('blog_tag', 'Id')->cascadeOnDelete();
            $table->primary(['post_Id', 'tag_Id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_post_tags');
    }
};
