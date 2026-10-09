<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('blog_post', function (Blueprint $table) {
            $table->dropColumn('excerpt');

            $table->foreign('category_id')->references('id')->on('blog_category')->restrictOnDelete();
            $table->unique(['author_id', 'title']);
            $table->index('title');
            $table->index(['published_at', 'status'], 'post_pub_status_idx');
        });
    }

    public function down(): void
    {
        Schema::table('blog_post', function (Blueprint $table) {
            $table->dropIndex('post_pub_status_idx');
            $table->dropIndex(['title']);
            $table->dropUnique(['author_id', 'title']);
            $table->dropForeign(['category_id']);
            $table->text('excerpt')->nullable();
        });
    }
};
