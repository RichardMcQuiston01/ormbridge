<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateBlogProfileTable extends Migration
{
    public function up()
    {
        Schema::create('blog_profile', function (Blueprint $table) {
            $table->increments('id');
            $table->text('bio')->nullable();
            $table->string('avatar', 100)->nullable();
            $table->unsignedInteger('user_id')->unique();

            $table->foreign('user_id')->references('id')->on('auth_user')->onDelete('cascade');
        });
    }

    public function down()
    {
        Schema::dropIfExists('blog_profile');
    }
}
