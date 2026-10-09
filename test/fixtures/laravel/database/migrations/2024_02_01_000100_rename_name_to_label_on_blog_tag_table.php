<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('blog_tag', function (Blueprint $table) {
            $table->renameColumn('name', 'label');
        });
    }

    public function down(): void
    {
        Schema::table('blog_tag', function (Blueprint $table) {
            $table->renameColumn('label', 'name');
        });
    }
};
