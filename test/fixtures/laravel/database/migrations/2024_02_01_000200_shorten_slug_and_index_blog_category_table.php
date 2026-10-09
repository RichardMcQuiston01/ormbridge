<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('blog_category', function (Blueprint $table) {
            $table->string('slug', 50)->change();
            $table->index('slug');
        });
    }

    public function down(): void
    {
        Schema::table('blog_category', function (Blueprint $table) {
            $table->dropIndex(['slug']);
            $table->string('slug', 100)->change();
        });
    }
};
