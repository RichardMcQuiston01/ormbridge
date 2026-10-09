<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('blog_category', function (Blueprint $table) {
            $table->unsignedInteger('parent_id')->nullable()->after('slug');
            $table->foreign('parent_id')->references('id')->on('blog_category')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('blog_category', function (Blueprint $table) {
            $table->dropForeign(['parent_id']);
            $table->dropColumn('parent_id');
        });
    }
};
