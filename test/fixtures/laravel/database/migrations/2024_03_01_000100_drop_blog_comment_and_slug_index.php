<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('blog_comment');

        Schema::table('blog_category', function (Blueprint $table) {
            $table->dropIndex('blog_category_slug_index');
        });
    }

    public function down(): void
    {
        Schema::table('blog_category', function (Blueprint $table) {
            $table->index('slug');
        });
    }
};
